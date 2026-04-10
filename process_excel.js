const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const readline = require('readline');

/**
 * 助手函数：在控制台提问并获取回答
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

/**
 * 助手函数：格式化日期时间用于生成不重复的文件名
 */
function getTimestamp() {
    const now = new Date();
    const date = now.toISOString().split('T')[0].replace(/-/g, '');
    const time = now.getTime();
    return `${date}_${time}`;
}

/**
 * 🌟 助手函数：计算数组的中位数 (对极端突刺完全免疫)
 */
function getMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 核心方法：基于【局部中位数】的严苛 Z-Score 过滤算法
 * 作用：精准识别并剔除极高/极低的突刺，并将散点云极度收束。
 */
function removeOutliers(dataArray, minKeep = 100) {
    // 转换为方便处理的格式，记录原始值、数值和原始索引
    const parsed = dataArray.map((val, idx) => ({ origVal: val, num: parseFloat(val), idx }));
    const validItems = parsed.filter(item => !isNaN(item.num));

    // 如果本身有效数据就不足 minKeep，则不进行剔除，直接返回
    if (validItems.length <= minKeep) {
        return validItems.map(item => item.origVal);
    }

    // 1. 扩大窗口大小，让局部基准线更稳定
    const windowSize = 11; 
    const halfWindow = Math.floor(windowSize / 2);

    // 2. 计算所有点的“偏离程度 (Z-Score)”
    const scoredItems = validItems.map((item, i) => {
        let localWindow = [];
        const start = Math.max(0, i - halfWindow);
        const end = Math.min(validItems.length - 1, i + halfWindow);
        for (let j = start; j <= end; j++) {
            localWindow.push(validItems[j].num);
        }

        // 计算局部中位数 (死死咬住大部队，不受 20000 这种极值影响)
        const localMedian = getMedian(localWindow);

        // 计算方差与标准差 (衡量这一小段范围的正常波动厚度)
        const variance = localWindow.reduce((a, b) => a + Math.pow(b - localMedian, 2), 0) / localWindow.length;
        const stdDev = Math.sqrt(variance);

        // 计算该点距离中位数的偏离程度
        const zScore = stdDev === 0 ? 0 : Math.abs(item.num - localMedian) / stdDev;

        return { ...item, zScore };
    });

    // 3. 极其严苛的剔除阈值 (偏离超过 0.8 个标准差统统杀掉)
    const strictThreshold = 0.8; 
    let filteredItems = scoredItems.filter(item => item.zScore <= strictThreshold);

    // 4. 保底策略：如果杀得太狠剩下的点不足 minKeep 个
    if (filteredItems.length < minKeep) {
        // 绝不放宽标准，直接按偏离程度(zScore)从小到大排雷
        const sortedByScore = [...scoredItems].sort((a, b) => a.zScore - b.zScore);
        
        // 强行截取排在最前面的 minKeep 个绝对核心点
        filteredItems = sortedByScore.slice(0, minKeep);
        
        // 恢复它们在 Excel 中原本的先后顺序，避免横坐标错乱
        filteredItems.sort((a, b) => a.idx - b.idx);
    }

    // 返回最终结果的原始值
    return filteredItems.map(item => item.origVal);
}

async function main() {
    console.log("=== Excel 数据提取与强力离散收束脚本 (中位数免疫版) ===");

    let inputDir = await askQuestion("请输入 Excel 数据目录路径 (例如 ./data): ");
    if (!inputDir) inputDir = "./data"; 

    let targetWavelength = await askQuestion("请输入要查找的波长 (第一列的值, 例如 500): ");
    if (!targetWavelength) {
        console.error("错误: 必须提供目标波长。");
        return;
    }

    if (!fs.existsSync(inputDir)) {
        console.error(`错误: 目录 "${inputDir}" 不存在，请检查路径。`);
        return;
    }

    const files = fs.readdirSync(inputDir).filter(file =>
        file.endsWith('.xlsx') || file.endsWith('.xls') || file.endsWith('.csv')
    );

    if (files.length === 0) {
        console.log("在该目录下未找到任何 Excel 或 CSV 文件。");
        return;
    }

    console.log(`\n正在处理 ${files.length} 个文件，采用边处理边追加的模式...\n`);

    // --- 初始化追加写入模式的 Excel 环境 ---
    const outFileName = `out_Filtered_${getTimestamp()}.xlsx`;
    const newWB = XLSX.utils.book_new();
    const newWS = XLSX.utils.aoa_to_sheet([]); 
    XLSX.utils.book_append_sheet(newWB, newWS, "Result");

    let outColIndex = 0; // 记录当前要写入到第几列

    files.forEach((file, index) => {
        try {
            const filePath = path.join(inputDir, file);
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];

            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // 查找第一列匹配的行
            const targetRowIndex = rows.findIndex(row =>
                row && row[0] !== undefined && Number(row[0]).toFixed(7) === Number(targetWavelength).toFixed(7)
            );

            if (targetRowIndex !== -1) {
                const rowData = rows[targetRowIndex];
                
                // 第0项是波长，数据点从第1项开始。切片分离出数据。
                const rawValues = rowData.slice(1);
                const beforeCount = rawValues.filter(v => v !== undefined && v !== "").length;

                // 核心：剔除极高/极低的散点，强力收束，并保证最少保留 100 个点
                // 你可以根据需要把 100 改成你截图里的 80
                const minKeepCount = 80;
                const smoothedValues = removeOutliers(rawValues, minKeepCount);
                const afterCount = smoothedValues.length;

                // 组装最终写入该列的数据: [文件名, 目标波长, 数据1, 数据2, ...]
                const finalColumnData = [file, rowData[0], ...smoothedValues];

                // 将一维数组转成二维垂直数组格式：[[val1], [val2], [val3]] 以供纵向追加写入
                const verticalDataForExcel = finalColumnData.map(val => [val !== undefined ? val : ""]);

                // 关键：向指定的列（outColIndex）写入这组数据
                XLSX.utils.sheet_add_aoa(newWS, verticalDataForExcel, { origin: { r: 0, c: outColIndex } });

                // 处理完一列立刻保存 Excel 文件 (实时落地，防止数据丢失)
                XLSX.writeFile(newWB, outFileName);
                
                console.log(`[写入完成] ${file} | 原始点: ${beforeCount} -> 保留: ${afterCount}`);
                
                outColIndex++; // 只有成功提取并写入后，列号才向后移
            } else {
                console.log(`[跳过] ${file}: 未找到匹配值 "${targetWavelength}"`);
            }
        } catch (err) {
            console.error(`[失败] ${file}: 读取/处理出错 - ${err.message}`);
        }
    });

    if (outColIndex === 0) {
        console.log("\n未提取到任何有效数据。");
        // 如果最终没数据可以删掉生成的空文件
        if(fs.existsSync(outFileName)) fs.unlinkSync(outFileName);
        return;
    }

    console.log(`\n====================================`);
    console.log(`全部追加处理完成！共提取了 ${outColIndex} 列数据。`);
    console.log(`输出结果保存至: ${path.resolve(outFileName)}`);
    console.log(`====================================`);
}

// 执行主程序
main().catch(err => {
    console.error("程序发生异常中断:", err);
});