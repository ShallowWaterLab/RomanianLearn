#!/usr/bin/env node
/**
 * 测试辅助：预置档案，让被测程序跳过「新建/选择档案」引导。
 *
 * 用法：
 *   const { seedProfile, profileFile } = require('./_testkit');
 *   const home = mkdtemp();
 *   seedProfile(home, '测试');          // 建好档案，启动即直接进入
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir(home) {
  return path.join(home, '.romanianlearn');
}

function profileDir(home) {
  return path.join(dataDir(home), 'profiles');
}

function profileFile(home, name) {
  return path.join(profileDir(home), name + '.json');
}

/**
 * 建一个档案，并把 index 指向它，使程序启动时直接进入该档案。
 * extra 可覆盖 totalCorrect / totalWrong / words / asked。
 */
function seedProfile(home, name = '测试', extra = {}) {
  const dir = profileDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const profile = {
    name,
    created: new Date().toISOString(),
    totalCorrect: 0,
    totalWrong: 0,
    words: {},
    asked: 0,
    ...extra,
  };
  fs.writeFileSync(profileFile(home, name),
                   JSON.stringify(profile, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dataDir(home), 'index.json'),
                   JSON.stringify({ current: name, profiles: [name] }, null, 2),
                   'utf-8');
  return profile;
}

function readProfile(home, name = '测试') {
  return JSON.parse(fs.readFileSync(profileFile(home, name), 'utf-8'));
}

/** 新建一个隔离的临时 HOME 并预置档案，返回 home 路径 */
function freshHome(name = '测试', extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_home_'));
  seedProfile(home, name, extra);
  return home;
}

module.exports = {
  seedProfile, readProfile, freshHome,
  dataDir, profileDir, profileFile,
};
