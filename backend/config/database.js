/**
 * EC9 Sequelize 连接（PostgreSQL）
 */
const { Sequelize } = require('sequelize');
const config = require('./index');

const sequelize = new Sequelize(config.database.name, config.database.user, config.database.password, {
  host: config.database.host,
  port: config.database.port,
  dialect: 'postgres',
  timezone: '+08:00',
  logging: false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  define: {
    timestamps: true,
    underscored: false
  }
});

async function testConnection() {
  await sequelize.authenticate();
  console.log(`数据库连接成功: ${config.database.name}@${config.database.host}`);
}

module.exports = { sequelize, testConnection };
