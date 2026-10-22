const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const LegalDoc = sequelize.define('LegalDoc', {
  doc_type: { type: DataTypes.STRING(30), allowNull: false, comment: 'user_agreement / privacy_policy' },
  lang: { type: DataTypes.STRING(10), defaultValue: 'zh-CN' },
  title: { type: DataTypes.STRING(200), allowNull: false },
  content: DataTypes.TEXT('long'),
  version: { type: DataTypes.STRING(20), defaultValue: '1.0' }
}, {
  tableName: 'ec9_legal_docs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = LegalDoc;
