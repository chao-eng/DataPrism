<script setup>
import { ref, onMounted } from "vue";
import { Plus, History, FileText, ChevronRight, BarChart2, Download, Filter, Loader2, X, Trash2, User } from "lucide-vue-next";
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
  minKeep: 80,
  maxY: ""
});

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  // 数据库存的是 UTC 字符串，转为本地日期格式
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

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
    alert(`初始化失败: ${err.message || err}`);
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
  if (chartRef.value) {
    // 检查当前 DOM 元素是否已经有关联的实例
    let existingInstance = echarts.getInstanceByDom(chartRef.value);
    
    if (!existingInstance) {
      chartInstance = echarts.init(chartRef.value);
      chartInstance.on("click", async (params) => {
        if (params.componentType === "series") {
          const pointId = params.data[2];
          await togglePointDeletion(pointId);
        }
      });

      // 监听框选事件
      chartInstance.on("brushSelected", async (params) => {
        const selected = params.batch[0].selected;
        const pointIdsToToggle = [];
        
        // 收集所有被框选到的点 ID
        for (let sIdx = 0; sIdx < selected.length; sIdx++) {
          const series = selected[sIdx];
          for (let dIdx = 0; dIdx < series.dataIndex.length; dIdx++) {
            const dataIdx = series.dataIndex[dIdx];
            // 从系列数据中获取 ID
            const pointId = chartInstance.getOption().series[sIdx].data[dataIdx][2];
            pointIdsToToggle.push(pointId);
          }
        }

        if (pointIdsToToggle.length > 0) {
          await batchToggleDeletion(pointIdsToToggle);
          // 清除选择框
          chartInstance.dispatchAction({ type: "brush", command: "clear", areas: [] });
          // 注释掉自动退出，保持框选状态
          /*
          chartInstance.dispatchAction({
            type: 'takeGlobalCursor',
            key: 'brush',
            brushOption: { brushType: false }
          });
          */
        }
      });
    } else {
      chartInstance = existingInstance;
    }
  }

  if (!chartInstance) return;

  const normalPoints = points.filter(p => p.is_deleted === 0).map(p => [p.x_index, p.original_value, p.id]);
  const deletedPoints = points.filter(p => p.is_deleted !== 0).map(p => [p.x_index, p.original_value, p.id]);

  const option = {
    tooltip: { trigger: "axis" },
    toolbox: {
      feature: {
        // 自定义“还原指针”按钮
        myReset: {
          show: true,
          title: '还原指针/平移模式',
          icon: 'path://M10,10 L15,15 M15,10 L10,15 M2,5 L8,5 M2,10 L8,10 M2,15 L5,15', 
          onclick: () => {
            chartInstance.dispatchAction({
              type: 'takeGlobalCursor',
              key: 'brush',
              brushOption: { brushType: false }
            });
          }
        },
        brush: { type: ["rect"], title: { rect: "手动框选剔除" } }
      },
      right: "center",
      top: 0
    },
    brush: {
      toolbox: ["rect"],
      xAxisIndex: 0,
      throttleType: "debounce",
      throttleDelay: 300
    },
    grid: { top: 60, right: 20, bottom: 40, left: 60 },
    xAxis: { type: "value", name: "采样点" },
    yAxis: { 
      type: "value", 
      name: "强度", 
      scale: true,
      max: reviewParams.value.maxY ? parseFloat(reviewParams.value.maxY) : null
    },
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

const batchToggleDeletion = async (pointIds) => {
  const db = await getDb();
  // 将框选到的点全部设为手动剔除 (is_deleted = 2)
  await db.execute(
    `UPDATE data_points SET is_deleted = 2 WHERE id IN (${pointIds.join(',')})`
  );
  await loadChartData();
};

const resetCurrentData = async () => {
  if (!activeFile.value) return;
  if (!confirm("确定要恢复本文件的所有采集点吗？(包括算法自动剔除和手动剔除的内容)")) return;
  
  const db = await getDb();
  await db.execute("UPDATE data_points SET is_deleted = 0 WHERE file_id = ?", [activeFile.value.id]);
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
    alert(`处理失败: ${err.message || err}`);
  }
};

const deleteTask = async (taskId, event) => {
  event.stopPropagation();
  if (!confirm("确定要删除该任务吗？此操作将永久删除该任务及其下的所有文件和处理数据。")) return;
  
  try {
    const db = await getDb();
    // 级联删除数据
    await db.execute("DELETE FROM data_points WHERE file_id IN (SELECT id FROM file_records WHERE task_id = ?)", [taskId]);
    await db.execute("DELETE FROM file_records WHERE task_id = ?", [taskId]);
    await db.execute("DELETE FROM tasks WHERE id = ?", [taskId]);
    await loadTasks();
  } catch (err) {
    alert(`删除失败: ${err.message || err}`);
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
    
    // Update task status to exported
    await db.execute("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?", [activeTask.value.id]);
    await loadTasks();

    isProcessing.value = false;
    alert(`成功导出至: ${savePath}`);
  } catch (err) {
    console.error("Export failed:", err);
    isProcessing.value = false;
    alert(`导出失败: ${err.message || err}`);
  }
};
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <img src="/logo.svg" alt="DataPrism Logo" class="brand-icon" />
        <span class="brand-name">DataPrism</span>
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
          <User :size="20" />
          <span>关于</span>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <header class="top-bar">
        <div class="page-title">
          <h2 v-if="currentTab === 'tasks'">任务概览</h2>
          <h2 v-else-if="currentTab === 'review'">可视化审核与干预</h2>
          <h2 v-else>关于</h2>
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
                  <span class="meta-item"><Filter :size="14" /> {{ task.target_wavelength }} nm</span>
                  <span class="meta-item">{{ formatDate(task.created_at) }}</span>
                </div>
              </div>
               <div class="header-right">
                <div v-if="task.status === 'COMPLETED'" class="status-badge">
                  已导出
                </div>
                <div class="btn-icon-danger" @click="deleteTask(task.id, $event)">
                  <Trash2 :size="16" />
                </div>
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
            <div class="file-list-container">
              <div class="file-list">
                <div 
                  v-for="file in activeFileList" 
                  :key="file.id" 
                  class="file-item" 
                  :class="{ active: activeFile?.id === file.id }"
                  @click="selectFile(file)"
                >
                  <FileText :size="16" class="file-icon" />
                  <span class="file-name">{{ file.file_name }}</span>
                </div>
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
                  <div class="control-group">
                    <label>强度上限 (Y)</label>
                    <input v-model="reviewParams.maxY" type="number" placeholder="自动" style="width: 80px;" @input="loadChartData">
                  </div>
                  <div class="btn-group">
                    <button class="btn-minor" @click="resetCurrentData">清空本页修改</button>
                    <button class="btn-minor" @click="reClean('current')">重新清洗</button>
                    <button class="btn-minor" @click="reClean('all')">全量应用算法</button>
                  </div>
                </div>
              </div>
              <div ref="chartRef" class="chart-canvas"></div>
            </div>
          </div>
        </div>

        <!-- About View -->
        <div v-if="currentTab === 'settings'" class="about-view">
          <div class="about-card card">
            <div class="about-brand">
              <img src="/logo.svg" alt="DataPrism Logo" class="brand-icon big" />
            </div>
            <div class="about-content">
              <h3>关于 DataPrism</h3>
              <p class="desc-main">
                <strong>DataPrism</strong> 是一款专为光谱/波长强度数据处理设计的桌面端工具。
              </p>
              <p>
                它解决了海量“波长-时间-强度”Excel数据文件中进行提取、清洗和人工校准的效率痛点。
              </p>
              <p>
                本应用基于现代化的轻量级桌面架构，实现多文件批量处理、基于 Z-Score 及局部中位数的算法自动过滤、可视化干预人工审核与结果的最终导出。
              </p>
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
  border-radius: 6px;
  display: block;
}

.brand-icon.big {
  width: 64px;
  height: 64px;
  font-size: 24px;
  margin: 0 auto 20px;
}

/* About View Styles */
.about-view {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 40px;
  height: 100%;
}

.about-card {
  max-width: 600px;
  padding: 40px;
  text-align: center;
}

.about-content h3 {
  font-size: 20px;
  margin-bottom: 24px;
  color: var(--color-text-main);
}

.about-content p {
  font-size: 15px;
  line-height: 1.8;
  color: var(--color-text-main);
  margin-bottom: 16px;
  text-align: left;
}

.about-content .desc-main {
  font-size: 16px;
  color: var(--color-text-main);
}

.version-tag {
  display: inline-block;
  margin-top: 24px;
  padding: 4px 12px;
  background-color: var(--color-bg-base);
  border-radius: 20px;
  font-size: 12px;
  color: var(--color-text-muted);
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

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-badge {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background-color: #E8FFEA;
  color: #00B42A;
}

.btn-icon-danger {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--color-text-muted);
  transition: all 0.2s;
}

.btn-icon-danger:hover {
  background-color: #FFEEED;
  color: var(--color-danger);
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

/* File List Improvements */
.review-sidebar {
  width: 260px;
  padding: 20px 0; /* Align with Feishu style (full-width items) */
  display: flex;
  flex-direction: column;
}

.section-title {
  padding: 0 16px;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--color-text-muted);
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.file-list-container {
  flex: 1;
  overflow-y: auto;
}

.file-list {
  padding: 0 8px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 2px;
  border-radius: var(--radius-m);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  color: var(--color-text-main);
  position: relative;
}

.file-item .file-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.file-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.file-item:hover {
  background-color: var(--color-bg-base);
}

.file-item.active {
  background-color: var(--color-primary-sub);
  color: var(--color-primary);
  font-weight: 500;
}

.file-item.active .file-icon {
  color: var(--color-primary);
}

/* Subtle active indicator */
.file-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background-color: var(--color-primary);
  border-radius: 0 4px 4px 0;
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

.control-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.control-group label {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.control-group input {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 13px;
}

.chart-canvas {
  flex: 1;
  min-height: 400px;
  background-color: var(--color-bg-base);
  border-radius: var(--radius-m);
}
</style>
