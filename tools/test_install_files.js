#!/usr/bin/env node
/**
 * 安装完整性检查（静态）
 *
 * 防止「程序新增了数据文件，但 install.sh 忘了下载」这类问题：
 * 程序运行时读取的每个 data/ 文件，都必须出现在 install.sh 的下载清单里。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'RomanianLearn.js');
const INSTALL = path.join(ROOT, 'install.sh');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// 1. 从主程序里解析所有 data/ 下的候选文件路径
const src = fs.readFileSync(SCRIPT, 'utf-8');
const referenced = new Set();
for (const m of src.matchAll(/path\.join\(\s*SCRIPT_DIR\s*,\s*'data'\s*,\s*'([^']+)'\s*\)/g)) {
  referenced.add(m[1]);
}
// 兼容 data/xxx 直接字面量写法
for (const m of src.matchAll(/'data\/([A-Za-z0-9_.\-]+)'/g)) {
  referenced.add(m[1]);
}

console.log('主程序引用的 data/ 文件:');
for (const f of [...referenced].sort()) console.log(`  - data/${f}`);

// 2. 只检查实际存在于仓库里的文件（可选回退文件可能不存在）
const existing = [...referenced].filter(f =>
  fs.existsSync(path.join(ROOT, 'data', f))
);

// 3. 检查 install.sh 是否下载了每一个
const installSrc = fs.readFileSync(INSTALL, 'utf-8');
console.log('\ninstall.sh 下载清单核对:');
for (const f of existing.sort()) {
  const wanted = `data/${f}`;
  const ok = installSrc.includes(wanted);
  check(`install.sh 下载 ${wanted}`, ok, '未在 install.sh 的下载清单中找到');
}

// 4. 反向检查：install.sh 下载的 data/ 文件是否都存在
console.log('\n反向核对（install.sh 引用了不存在的文件）:');
const dlMatches = [...installSrc.matchAll(/download\s+"\$\{RAW\}\/(data\/[^"]+)"/g)];
if (dlMatches.length === 0) {
  check('能解析出 install.sh 的下载清单', false, '未匹配到 download 行');
}
for (const m of dlMatches) {
  const rel = m[1];
  const exists = fs.existsSync(path.join(ROOT, rel));
  check(`${rel} 在仓库中存在`, exists, '文件不存在，安装会失败');
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
