'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/convert');

// Exact shape from a real failing session: the root object's closing brace is missing
// and stray DSML closing tags follow.
const RAW = 'Good pick. Two things before I install:\nHotkey: which do you want?\n' +
  '<tool_call>{"name":"AskUserQuestion","arguments":{"questions":[{"question":"How should I bind Win+Shift+S to            Flameshot?","header":"Hotkey","multiSelect":false,"options":[' +
  '{"label":"AutoHotkey intercept                             (Recommended)","description":"Small AHK script running at startup."},' +
  '{"label":"Disable Windows shortcut via registry","description":"Turn it off, then bind with AHK."},' +
  '{"label":"Use Flameshot\'s own shortcut","description":"Skip AHK. Leave Win+Shift+S alone."}]}]}' +
  '</｜｜DSML｜｜ parameter>                \n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>       ';

test('call missing the final closing brace is recovered', () => {
  const r = c.parseToolCalls(RAW, [{ name: 'AskUserQuestion' }]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'AskUserQuestion');
  const q = r.calls[0].arguments.questions[0];
  assert.equal(q.header, 'Hotkey');
  assert.equal(q.options.length, 3);
  assert.equal(q.options[2].label, "Use Flameshot's own shortcut");
  assert.match(r.text, /^Good pick/);
  assert.doesNotMatch(r.text, /DSML|tool_call/);
});

test('call truncated at end of text (no closing tags at all) is recovered', () => {
  const r = c.parseToolCalls('<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"', [{ name: 'Read' }]);
  assert.deepEqual(r.calls, [{ name: 'Read', arguments: { file_path: 'a.txt' } }]);
});

test('unterminated string is not guessed at', () => {
  const r = c.parseToolCalls('<tool_call>{"name":"Read","arguments":{"file_path":"a.tx', [{ name: 'Read' }]);
  assert.equal(r.calls.length, 0);
});
