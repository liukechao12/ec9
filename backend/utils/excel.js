const XLSX = require('xlsx');

/**
 * 解析通用嘉宾导入 Excel（姓名 / 手机 / 公司 / 备注）
 * @param {Buffer} fileBuffer - 文件缓冲区
 * @returns {Array} 解析后的数据数组
 */
function parseExcel(fileBuffer) {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames && workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Excel文件中未找到工作表');
    }
    const worksheet = workbook.Sheets && workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error(`未找到工作表: ${sheetName}`);
    }
    
    // 转换为JSON数组
    const data = XLSX.utils.sheet_to_json(worksheet);
    
    return data.map((row, index) => {
      // 标准化字段名（支持多种可能的列名）
      const name = row['姓名'] || row['name'] || row['Name'] || row['嘉宾姓名'] || '';
      const phone = row['手机号'] || row['phone'] || row['Phone'] || row['手机'] || row['电话'] || '';
      const company = row['公司'] || row['company'] || row['Company'] || row['公司名称'] || row['单位'] || '';
      const position =
        row['职位'] || row['职务'] || row['position'] || row['Position'] || row['岗位'] || '';
      const bdId =
        row['邀请人'] || row['BDID'] || row['bd_id'] || row['bdId'] ||
        row['BD账号'] || row['BD'] || row['来源BD'] || row['source_bd'] || '';
      const remark = row['备注'] || row['remark'] || row['Remark'] || row['说明'] || '';
      
      return {
        row: index + 2, // Excel行号（从2开始，因为第1行是标题）
        name: String(name).trim(),
        phone: String(phone).trim().replace(/\s+/g, ''),
        company: String(company || '').trim(),
        position: String(position || '').trim(),
        bd_id: String(bdId || '').trim(),
        remark: String(remark || '').trim()
      };
    }).filter(row => row.name && row.phone); // 过滤空行
  } catch (error) {
    throw new Error(`解析Excel失败: ${error.message}`);
  }
}

/**
 * 验证手机号格式
 * @param {string} phone - 手机号
 * @returns {boolean}
 */
function validatePhone(phone) {
  const phoneRegex = /^1[3-9]\d{9}$/;
  return phoneRegex.test(phone);
}

/**
 * 生成Excel导入结果报告
 * @param {Array} results - 导入结果数组
 * @returns {Object} 统计信息
 */
function generateImportReport(results) {
  const total = results.length;
  const success = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  return {
    total,
    success,
    failed,
    successRate: total > 0 ? ((success / total) * 100).toFixed(2) + '%' : '0%',
    details: results
  };
}

/**
 * 解析 BD/管理员 导入 Excel
 * 期望列名（任意一个匹配即可）：
 * - 用户名：用户名 / 账号 / username / Username
 * - 密码：密码 / password / Password
 * - 姓名：姓名 / name / Name
 * - 联系方式：联系方式 / 联系人方式 / 手机 / 电话 / 手机号 / contact / Contact
 */
function parseBdExcel(fileBuffer) {
  try {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames && workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Excel文件中未找到工作表');
    }
    const worksheet = workbook.Sheets && workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error(`未找到工作表: ${sheetName}`);
    }
    const data = XLSX.utils.sheet_to_json(worksheet);

    return data.map((row, index) => {
      const username =
        row['用户名'] || row['账号'] || row['username'] || row['Username'] || '';
      const password =
        row['密码'] || row['password'] || row['Password'] || '';
      const name =
        row['姓名'] || row['name'] || row['Name'] || row['BD姓名'] || '';
      const contact =
        row['联系方式'] || row['联系人方式'] || row['手机'] || row['手机号'] ||
        row['电话'] || row['contact'] || row['Contact'] || '';

      return {
        row: index + 2,
        username: String(username || '').trim(),
        password: String(password || '').trim(),
        name: String(name || '').trim(),
        contact: String(contact || '').trim()
      };
    }).filter(row => row.username); // 至少有用户名才算有效一行
  } catch (error) {
    throw new Error(`解析BD Excel失败: ${error.message}`);
  }
}

module.exports = {
  parseExcel,
  validatePhone,
  generateImportReport,
  parseBdExcel
};

