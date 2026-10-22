const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// 确保上传目录存在
const uploadDir = path.join(__dirname, '../uploads/qrcodes');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * 生成二维码图片
 * @param {string} data - 二维码数据
 * @param {string} filename - 文件名（不含扩展名）
 * @returns {Promise<{url: string, data: string}>}
 */
async function generateQRCode(data, filename) {
  try {
    const filePath = path.join(uploadDir, `${filename}.png`);
    const url = `/uploads/qrcodes/${filename}.png`;
    
    // 生成二维码图片
    await QRCode.toFile(filePath, data, {
      errorCorrectionLevel: 'H',
      type: 'png',
      width: 300,
      margin: 1
    });
    
    // 返回二维码数据（base64）
    const qrCodeData = await QRCode.toDataURL(data, {
      errorCorrectionLevel: 'H',
      width: 300
    });
    
    return {
      url: url,
      data: qrCodeData
    };
  } catch (error) {
    console.error('生成二维码失败:', error);
    throw error;
  }
}

/**
 * 生成邀约二维码
 * @param {string} inviteCode - 邀约码
 * @param {string} baseUrl - 前端基础URL
 * @returns {Promise<{url: string, data: string}>}
 */
async function generateInviteQRCode(inviteCode, baseUrl) {
  const inviteUrl = `${baseUrl}/invite/${inviteCode}`;
  return await generateQRCode(inviteUrl, `invite_${inviteCode}`);
}

/**
 * 生成门票二维码
 * @param {string} ticketCode - 门票码
 * @returns {Promise<{url: string, data: string}>}
 */
async function generateTicketQRCode(ticketCode) {
  const ticketData = `ticket:${ticketCode}`;
  return await generateQRCode(ticketData, `ticket_${ticketCode}`);
}

/**
 * 生成签到码二维码
 * @param {string} checkinCode - 签到码
 * @returns {Promise<{url: string, data: string}>}
 */
async function generateCheckinQRCode(checkinCode) {
  const checkinData = `checkin:${checkinCode}`;
  return await generateQRCode(checkinData, `checkin_${checkinCode}`);
}

module.exports = {
  generateQRCode,
  generateInviteQRCode,
  generateTicketQRCode,
  generateCheckinQRCode
};

