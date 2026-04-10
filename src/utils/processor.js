import { read, utils } from 'xlsx';
import { readFile } from '@tauri-apps/plugin-fs';
import { getDb } from './db';

/**
 * 计算数组的中位数
 */
function getMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 核心算法：基于局部中位数的 Z-Score 过滤
 */
export function applyZScoreFilter(dataArray, threshold = 0.8, minKeep = 80) {
  const parsed = dataArray.map((val, idx) => ({ 
    origVal: val, 
    num: parseFloat(val), 
    idx 
  }));
  const validItems = parsed.filter(item => !isNaN(item.num));

  if (validItems.length <= minKeep) {
    return validItems.map(item => ({ ...item, isDeleted: 0 }));
  }

  const windowSize = 11;
  const halfWindow = Math.floor(windowSize / 2);

  const scoredItems = validItems.map((item, i) => {
    let localWindow = [];
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(validItems.length - 1, i + halfWindow);
    for (let j = start; j <= end; j++) {
      localWindow.push(validItems[j].num);
    }

    const localMedian = getMedian(localWindow);
    const variance = localWindow.reduce((a, b) => a + Math.pow(b - localMedian, 2), 0) / localWindow.length;
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev === 0 ? 0 : Math.abs(item.num - localMedian) / stdDev;

    return { ...item, zScore, localMedian };
  });

  // Apply strict threshold
  let filteredItems = scoredItems.map(item => ({
    ...item,
    isDeleted: item.zScore > threshold ? 1 : 0
  }));

  // Safety insurance for minimum points
  const activeCount = filteredItems.filter(item => item.isDeleted === 0).length;
  if (activeCount < minKeep) {
    const sortedByScore = [...scoredItems].sort((a, b) => a.zScore - b.zScore);
    const topKeepIds = new Set(sortedByScore.slice(0, minKeep).map(it => it.idx));
    
    filteredItems = scoredItems.map(item => ({
      ...item,
      isDeleted: topKeepIds.has(item.idx) ? 0 : 1
    }));
  }

  return filteredItems;
}

/**
 * 处理单个 Excel 文件
 */
export async function processFile(filePath, fileName, targetWavelength, taskId) {
  const db = await getDb();
  
  // 1. 读取文件内容
  const content = await readFile(filePath);
  const workbook = read(content);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = utils.sheet_to_json(sheet, { header: 1 });

  // 2. 定位目标波长行
  const targetRowIndex = rows.findIndex(row => 
    row && row[0] !== undefined && Number(row[0]).toFixed(7) === Number(targetWavelength).toFixed(7)
  );

  if (targetRowIndex === -1) return null;

  const rowData = rows[targetRowIndex];
  const rawValues = rowData.slice(1);

  // 3. 创建文件记录
  const res = await db.execute(
    'INSERT INTO file_records (task_id, file_name) VALUES (?, ?)',
    [taskId, fileName]
  );
  const fileId = res.lastInsertId;

  // 4. 执行清洗算法
  const filteredData = applyZScoreFilter(rawValues);

  // 5. 批量落库 (使用事务提高性能)
  // 注意：大数据量下建议分批插入或优化 SQL
  const insertQuery = `
    INSERT INTO data_points (file_id, x_index, original_value, filtered_value, is_deleted)
    VALUES ${filteredData.map(() => '(?, ?, ?, ?, ?)').join(',')}
  `;
  
  const params = [];
  filteredData.forEach((item, i) => {
    params.push(fileId, i, item.num, item.num, item.isDeleted);
  });

  await db.execute(insertQuery, params);
  
  return { fileId, fileName, count: filteredData.length };
}
