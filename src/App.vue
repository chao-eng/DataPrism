<script setup>
import { ref, onMounted } from "vue";
import { Plus, History, Settings, FileText, ChevronRight, BarChart2, Download, Filter, Loader2, X } from "lucide-vue-next";
import { initDb, getDb } from "./utils/db";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, writeFile } from "@tauri-apps/plugin-fs";
import * as echarts from "echarts";
import { utils, write } from "xlsx";
import { processFile, applyZScoreFilter } from "./utils/processor";

const currentTab = ref("tasks");
const tasks = ref([]);
const isProcessing = ref(false);
const showNewTaskModal = ref(false);

const activeTask = ref(null);
const activeFileList = ref([]);
const activeFile = ref(null);
const chartRef = ref(null);
let chartInstance = null;

// Review parameters
const reviewParams = ref({
  zScore: 0.8,
  minKeep: 80
});

// New task form... (rest of codes)
const newTask = ref({
  name: "",
  folderPath: "",
  wavelength: "500",
});

const progress = ref({
  total: 0,
  current: 0,
  currentFile: "",
});

onMounted(async () => {
  try {
    await initDb();
    await loadTasks();
    window.addEventListener("resize", () => chartInstance?.resize());
  } catch (err) {
    console.error("Initialization error:", err);
  }
});

const loadTasks = async () => {
  const db = await getDb();
  const res = await db.select("SELECT * FROM tasks ORDER BY created_at DESC");
  
  for (const task of res) {
    const fileCountRes = await db.select("SELECT COUNT(*) as count FROM file_records WHERE task_id = ?", [task.id]);
    task.files = fileCountRes[0].count;
  }
  tasks.value = res;
};

const selectTask = async (task) => {
  activeTask.value = task;
  currentTab.value = "review";
  const db = await getDb();
  activeFileList.value = await db.select("SELECT * FROM file_records WHERE task_id = ?", [task.id]);
  if (activeFileList.value.length > 0) {
    await selectFile(activeFileList.value[0]);
  }
};

const selectFile = async (file) => {
  activeFile.value = file;
  await loadChartData();
};

const loadChartData = async () => {
  if (!activeFile.value) return;
  const db = await getDb();
  const points = await db.select(
    "SELECT id, x_index, original_value, filtered_value, is_deleted FROM data_points WHERE file_id = ? ORDER BY x_index",
    [activeFile.value.id]
  );
  renderChart(points);
};

const renderChart = (points) => {
  if (!chartInstance && chartRef.value) {
    chartInstance = echarts.init(chartRef.value);
    chartInstance.on("click", async (params) => {
      if (params.componentType === "series") {
        const pointId = params.data[2]; // We'll store ID in the 3rd index
        await togglePointDeletion(pointId);
      }
    });
  }

  const normalPoints = points.filter(p => p.is_deleted === 0).map(p => [p.x_index, p.original_value, p.id]);
  const deletedPoints = points.filter(p => p.is_deleted !== 0).map(p => [p.x_index, p.original_value, p.id]);

  const option = {
    tooltip: { trigger: "axis" },
    grid: { top: 40, right: 20, bottom: 40, left: 60 },
    xAxis: { type: "value", name: "采样点" },
    yAxis: { type: "value", name: "强度", scale: true },
    dataZoom: [{ type: "inside" }, { type: "slider" }],
    series: [
      {
        name: "有效点",
        type: "scatter",
        data: normalPoints,
        symbolSize: 6,
        itemStyle: { color: "#3370FF" },
      },
      {
        name: "剔除点",
        type: "scatter",
        data: deletedPoints,
        symbolSize: 6,
        itemStyle: { color: "#F54A45", opacity: 0.3 },
      }
    ]
  };

  chartInstance.setOption(option);
};

const togglePointDeletion = async (pointId) => {
  const db = await getDb();
  // Toggle between 0 and 2 (Manual deleted)
  await db.execute(
    "UPDATE data_points SET is_deleted = CASE WHEN is_deleted = 0 THEN 2 ELSE 0 END WHERE id = ?",
    [pointId]
  );
  await loadChartData();
};

const reClean = async (scope = 'current') => {
  const db = await getDb();
  const filesToProcess = scope === 'all' ? activeFileList.value : [activeFile.value];
  
  isProcessing.value = true;
  progress.value.total = filesToProcess.length;
  progress.value.current = 0;

  for (const file of filesToProcess) {
    progress.value.currentFile = file.file_name;
    const points = await db.select("SELECT * FROM data_points WHERE file_id = ? ORDER BY x_index", [file.id]);
    const rawValues = points.map(p => p.original_value);
    const filtered = applyZScoreFilter(rawValues, reviewParams.value.zScore, reviewParams.value.minKeep);
    
    // Update DB
    for (let i = 0; i < points.length; i++) {
      await db.execute(
        "UPDATE data_points SET is_deleted = ?, filtered_value = ? WHERE id = ?",
        [filtered[i].isDeleted, filtered[i].num, points[i].id]
      );
    }
    progress.value.current++;
  }
  
  isProcessing.value = false;
  await loadChartData();
};

const selectFolder = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择数据源文件夹"
  });
  if (selected) {
    newTask.value.folderPath = selected;
    if (!newTask.value.name) {
      newTask.value.name = selected.split(/[\\/]/).pop() || "未命名任务";
    }
  }
};

const startTask = async () => {
  if (!newTask.value.folderPath || !newTask.value.wavelength) return;
  
  try {
    isProcessing.value = true;
    showNewTaskModal.value = false;
    
    // 1. Scan folder
    const entries = await readDir(newTask.value.folderPath);
    const excelFiles = entries.filter(e => e.name.endsWith(".xlsx") || e.name.endsWith(".xls"));
    
    if (excelFiles.length === 0) {
      alert("选定文件夹内未找到 Excel 文件");
      isProcessing.value = false;
      return;
    }

    const db = await getDb();
    
    // 2. Create Task Record
    const taskRes = await db.execute(
      "INSERT INTO tasks (name, target_wavelength) VALUES (?, ?)",
      [newTask.value.name, parseFloat(newTask.value.wavelength)]
    );
    const taskId = taskRes.lastInsertId;

    // 3. Process files one by one (or in parallel batches)
    progress.value.total = excelFiles.length;
    progress.value.current = 0;

    for (const file of excelFiles) {
      progress.value.currentFile = file.name;
      const fullPath = `${newTask.value.folderPath}/${file.name}`;
      await processFile(fullPath, file.name, newTask.value.wavelength, taskId);
      progress.value.current++;
    }

    // 4. Update task status
    await db.execute("UPDATE tasks SET status = 'PENDING_REVIEW' WHERE id = ?", [taskId]);
    
    await loadTasks();
    isProcessing.value = false;
    alert("处理完成！");
  } catch (err) {
    console.error("Processing failed:", err);
    isProcessing.value = false;
    alert(`处理失败: ${err.message}`);
  }
};

const exportTask = async () => {
  if (!activeTask.value) return;
  
  try {
    const savePath = await save({
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
      defaultPath: `Result_${activeTask.value.name}.xlsx`
    });

    if (!savePath) return;

    isProcessing.value = true;
    progress.value.total = activeFileList.value.length;
    progress.value.current = 0;

    const db = await getDb();
    const columns = [];

    for (const file of activeFileList.value) {
      progress.value.currentFile = `准备导出: ${file.file_name}`;
      
      const points = await db.select(
        "SELECT filtered_value FROM data_points WHERE file_id = ? AND is_deleted = 0 ORDER BY x_index",
        [file.id]
      );

      // Construct column: [FileName, Wavelength, ...Data]
      const colData = [
        file.file_name,
        activeTask.value.target_wavelength,
        ...points.map(p => p.filtered_value)
      ];
      columns.push(colData);
      progress.value.current++;
    }

    // Transform columns to rows for XLSX
    // Find max length
    const maxLen = Math.max(...columns.map(c => c.length));
    const rows = [];
    for (let r = 0; r < maxLen; r++) {
      const row = columns.map(col => col[r] ?? "");
      rows.push(row);
    }

    // Create workbook
    const ws = utils.aoa_to_sheet(rows);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Spectral Data");

    // Write file
    const excelBuffer = write(wb, { bookType: "xlsx", type: "array" });
    await writeFile(savePath, new Uint8Array(excelBuffer));
    
    isProcessing.value = false;
    alert(`成功导出至: ${savePath}`);
  } catch (err) {
    console.error("Export failed:", err);
    isProcessing.value = false;
    alert(`导出失败: ${err.message}`);
  }
};
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-icon">rou</div>
        <span class="brand-name">rou-tools</span>
      </div>
      
      <nav class="nav-menu">
        <div 
          class="nav-item" 
          :class="{ active: currentTab === 'tasks' }" 
          @click="currentTab = 'tasks'"
        >
          <History :size="20" />
          <span>任务列表</span>
        </div>
        <div 
          class="nav-item" 
          :class="{ active: currentTab === 'review' }" 
          @click="currentTab = 'review'"
        >
          <BarChart2 :size="20" />
          <span>可视化审核</span>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="nav-item" @click="currentTab = 'settings'">
          <Settings :size="20" />
          <span>系统设置</span>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <header class="top-bar">
        <div class="page-title">
          <h2 v-if="currentTab === 'tasks'">任务概览</h2>
          <h2 v-else-if="currentTab === 'review'">可视化审核与干预</h2>
          <h2 v-else>设置</h2>
        </div>
        
        <div class="actions">
          <button v-if="currentTab === 'tasks'" class="btn-primary" @click="showNewTaskModal = true">
            <Plus :size="18" />
            <span>新建处理任务</span>
          </button>
          <button v-if="currentTab === 'review'" class="btn-success" @click="exportTask">
            <Download :size="18" />
            <span>导出结果 Excel</span>
          </button>
        </div>
      </header>

      <div class="content-body">
        <!-- Processing Overlay -->
        <div v-if="isProcessing" class="processing-overlay">
          <div class="processing-card card">
            <Loader2 class="spin-icon" :size="48" color="var(--color-primary)" />
            <h3>正在分析光谱数据...</h3>
            <p class="progress-details">{{ progress.current }} / {{ progress.total }} 文件</p>
            <p class="current-file">{{ progress.currentFile }}</p>
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" :style="{ width: (progress.current / progress.total * 100) + '%' }"></div>
            </div>
          </div>
        </div>

        <!-- New Task Modal -->
        <div v-if="showNewTaskModal" class="modal-backdrop">
          <div class="modal card">
            <div class="modal-header">
              <h3>新建处理任务</h3>
              <X class="cursor-pointer" @click="showNewTaskModal = false" />
            </div>
            <div class="modal-body">
              <div class="form-item">
                <label>任务显示名称</label>
                <input v-model="newTask.name" type="text" placeholder="例如：2026-批次A-500nm" />
              </div>
              <div class="form-item">
                <label>数据源文件夹</label>
                <div class="input-group">
                  <input v-model="newTask.folderPath" type="text" readonly placeholder="请选择包含 Excel 文件的文件夹" />
                  <button class="btn-minor" @click="selectFolder">选择</button>
                </div>
              </div>
              <div class="form-item">
                <label>目标提取波长 (nm)</label>
                <input v-model="newTask.wavelength" type="number" step="0.0001" placeholder="500.0000" />
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn-minor" @click="showNewTaskModal = false">取消</button>
              <button class="btn-primary" :disabled="!newTask.folderPath" @click="startTask">开始分析处理</button>
            </div>
          </div>
        </div>
        <!-- Task List View -->
        <div v-if="currentTab === 'tasks'" class="task-grid">
          <div v-for="task in tasks" :key="task.id" class="task-card card cursor-pointer" @click="selectTask(task)">
            <div class="task-card-header">
              <div class="task-info">
                <h3 class="task-name">{{ task.name }}</h3>
                <div class="task-meta">
                  <span class="meta-item"><FileText :size="14" /> {{ task.files }} 个文件</span>
                  <span class="meta-item"><Filter :size="14" /> {{ task.wavelength }} nm</span>
                </div>
              </div>
              <div class="status-badge" :class="task.status.toLowerCase()">
                {{ task.status === 'PENDING_REVIEW' ? '待审核' : '已完成' }}
              </div>
            </div>
            <div class="task-card-footer">
              <span class="task-date">{{ task.date }}</span>
              <ChevronRight :size="18" class="arrow-icon" />
            </div>
          </div>
        </div>

        <!-- Review View Placeholder -->
        <div v-if="currentTab === 'review'" class="review-layout">
          <div class="review-sidebar card">
            <div class="section-title">文件列表</div>
            <div class="file-list">
              <div 
                v-for="file in activeFileList" 
                :key="file.id" 
                class="file-item" 
                :class="{ active: activeFile?.id === file.id }"
                @click="selectFile(file)"
              >
                <FileText :size="16" />
                <span>{{ file.file_name }}</span>
              </div>
            </div>
          </div>
          <div class="review-main">
            <div class="chart-container card">
              <div class="chart-header">
                <div class="chart-title">
                  {{ activeFile?.file_name }} 强度分布图 ({{ activeTask?.target_wavelength }} nm)
                </div>
                <div class="chart-controls">
                  <div class="control-group">
                    <label>收束程度 (Z阈值: {{ reviewParams.zScore }})</label>
                    <input v-model.number="reviewParams.zScore" type="range" min="0.1" max="2.0" step="0.1">
                  </div>
                  <div class="control-group">
                    <label>存活点数</label>
                    <input v-model.number="reviewParams.minKeep" type="number" style="width: 60px;">
                  </div>
                  <div class="btn-group">
                    <button class="btn-minor" @click="reClean('current')">重洗当前</button>
                    <button class="btn-minor" @click="reClean('all')">全量应用</button>
                  </div>
                </div>
              </div>
              <div ref="chartRef" class="chart-canvas"></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background-color: var(--color-bg-base);
}

/* Sidebar */
.sidebar {
  width: 240px;
  background-color: var(--color-surface);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  padding: 24px 12px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px 32px;
}

.brand-icon {
  width: 32px;
  height: 32px;
  background-color: var(--color-primary);
  border-radius: 6px;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 14px;
}

.brand-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text-main);
  letter-spacing: -0.5px;
}

.nav-menu {
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  color: var(--color-text-main);
  transition: var(--transition-base);
  margin-bottom: 4px;
  cursor: pointer;
  font-size: 14px;
}

.nav-item:hover {
  background-color: var(--color-bg-base);
}

.nav-item.active {
  background-color: var(--color-primary-sub);
  color: var(--color-primary);
  font-weight: 500;
}

.sidebar-footer {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}

/* Main Content */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.top-bar {
  height: 64px;
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}

.top-bar h2 {
  font-size: 16px;
  font-weight: 600;
}

.content-body {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

/* Buttons */
.btn-primary, .btn-success, .btn-minor {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: var(--radius-s);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: var(--transition-base);
}

.btn-primary {
  background-color: var(--color-primary);
  color: white;
}

.btn-primary:hover {
  background-color: var(--color-primary-hover);
}

.btn-success {
  background-color: var(--color-success);
  color: white;
}

.btn-minor {
  background-color: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-main);
}

.btn-minor:hover {
  background-color: var(--color-bg-base);
  border-color: var(--color-border-hover);
}

/* Task Cards */
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.task-card {
  transition: var(--transition-base);
}

.task-card:hover {
  border-color: var(--color-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.05);
}

.task-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.task-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.task-meta {
  display: flex;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.status-badge.pending_review {
  background-color: #FFF2E8;
  color: #FA8C16;
}

.status-badge.completed {
  background-color: #F6FFED;
  color: #52C41A;
}

.task-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid var(--color-bg-base);
}

.task-date {
  color: var(--color-text-muted);
  font-size: 12px;
}

.arrow-icon {
  color: var(--color-border-hover);
}

/* Modals & Overlays */
.modal-backdrop, .processing-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(31, 35, 41, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.modal {
  width: 500px;
  padding: 0;
}

.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  padding: 24px 20px;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

/* Processing Card */
.processing-card {
  width: 400px;
  text-align: center;
  padding: 40px 32px;
}

.processing-card h3 {
  margin: 16px 0 8px;
  font-size: 18px;
}

.progress-details {
  font-size: 14px;
  color: var(--color-text-muted);
}

.current-file {
  font-size: 12px;
  color: var(--color-primary);
  margin: 12px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.progress-bar-bg {
  height: 8px;
  background-color: var(--color-bg-base);
  border-radius: 10px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background-color: var(--color-primary);
  transition: width 300ms ease;
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Forms */
.form-item {
  margin-bottom: 20px;
}

.form-item label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--color-text-main);
}

.form-item input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-s);
  font-size: 14px;
  transition: var(--transition-base);
}

.form-item input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-sub);
}

.input-group {
  display: flex;
  gap: 8px;
}

.input-group input {
  flex: 1;
}

/* Review Layout */
.review-layout {
  display: flex;
  gap: 20px;
  height: 100%;
}

.review-sidebar {
  width: 280px;
  padding: 16px;
}

.review-main {
  flex: 1;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-s);
  font-size: 13px;
  cursor: pointer;
  transition: var(--transition-base);
  color: var(--color-text-main);
}

.file-item:hover {
  background-color: var(--color-bg-base);
}

.file-item.active {
  background-color: var(--color-primary-sub);
  color: var(--color-primary);
  font-weight: 500;
}

.chart-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.chart-title {
  font-weight: 600;
  font-size: 15px;
}

.chart-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

.btn-group {
  display: flex;
  gap: 8px;
}

.chart-canvas {
  flex: 1;
  min-height: 400px;
  background-color: var(--color-bg-base);
  border-radius: var(--radius-m);
}
</style>
