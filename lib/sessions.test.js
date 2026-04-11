const test = require('node:test');
const assert = require('node:assert/strict');
const { projectPathHash } = require('./sessions');

test('projectPathHash converts Windows path', () => {
  assert.equal(projectPathHash('D:\\work\\project'), 'D--work-project');
});
test('projectPathHash converts spaces', () => {
  assert.equal(projectPathHash('C:\\Users\\Dan\\New folder'), 'C--Users-Dan-New-folder');
});
test('projectPathHash converts Unix path', () => {
  assert.equal(projectPathHash('/home/user/project'), '-home-user-project');
});
test('projectPathHash is deterministic', () => {
  assert.equal(projectPathHash('D:\\test'), projectPathHash('D:\\test'));
});
test('projectPathHash handles forward slashes', () => {
  assert.equal(projectPathHash('D:/work/project'), 'D--work-project');
});
test('projectPathHash handles single segment', () => {
  assert.equal(typeof projectPathHash('project'), 'string');
});
