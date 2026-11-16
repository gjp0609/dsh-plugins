import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_FILE = join(PACKAGE_ROOT, 'client.js');
const PURE_FILE = join(PACKAGE_ROOT, 'src', 'pure.mjs');

const START = '// ==== pure（与 src/pure.mjs 逐字一致，见 DECISIONS.md）====';
const END = '// ==== /pure ====';

function sliceBlock(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text.split(START).length, 2, `${file} 里 ${START} 必须恰好出现一次`);
  assert.equal(text.split(END).length, 2, `${file} 里 ${END} 必须恰好出现一次`);
  const start = text.indexOf(START);
  const end = text.indexOf(END, start + START.length);
  return text.slice(start + START.length, end).replace(/^\n/, '').replace(/\n$/, '');
}

function firstDifference(left, right) {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const limit = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return [
        `第 ${index + 1} 行开始不同：`,
        `  pure.mjs（去掉 export 后）: ${JSON.stringify(leftLines[index])}`,
        `  client.js 副本          : ${JSON.stringify(rightLines[index])}`,
      ].join('\n');
    }
  }
  return '内容相同但长度不同';
}

test('client.js 的 pure 副本与 src/pure.mjs 逐字一致（只允许差 export 关键字）', () => {
  const pure = sliceBlock(PURE_FILE).replace(/^export /gm, '');
  const client = sliceBlock(CLIENT_FILE);
  assert.equal(client, pure, firstDifference(pure, client));
});
