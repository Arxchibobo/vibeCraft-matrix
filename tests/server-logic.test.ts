import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokenCount,
  parseTokensFromOutput,
  detectPermissionPrompt
} from '../server/utils.js';

test('estimateTokenCount', () => {
  // English text (~4 chars per token)
  assert.equal(estimateTokenCount('Hello world'), 3); // 11 chars / 4 = 2.75 -> 3
  assert.equal(estimateTokenCount('This is a longer sentence for testing.'), 10); // 38 chars / 4 = 9.5 -> 10

  // Code text (~3 chars per token)
  assert.equal(estimateTokenCount('function test() {\n  return 1;\n}'), 11); // 32 chars / 3 = 10.6 -> 11

  // JSON (~3.5 chars per token)
  assert.equal(estimateTokenCount('{"key": "value", "id": 123}'), 8); // 27 chars / 3.5 = 7.7 -> 8

  // Empty string
  assert.equal(estimateTokenCount(''), 0);
});

test('parseTokensFromOutput', () => {
  // Plain numbers
  assert.equal(parseTokensFromOutput('↓ 879 tokens'), 879);
  assert.equal(parseTokensFromOutput('Some other text ↓ 1,234 tokens and more'), 1234);

  // K suffix
  assert.equal(parseTokensFromOutput('↓ 12.5k tokens'), 12500);
  assert.equal(parseTokensFromOutput('↓ 12k tokens'), 12000);

  // Multiple matches (should pick max)
  assert.equal(parseTokensFromOutput('↓ 500 tokens ... ↓ 1,000 tokens'), 1000);

  // No match
  assert.equal(parseTokensFromOutput('No tokens here'), null);
});

test('detectPermissionPrompt', () => {
  // Standard prompt
  const standardOutput = `
● Bash(rm /tmp/test.txt)
⎿  Running PreToolUse hook…
─────────────────────────────
Bash command

   rm /tmp/test.txt

Do you want to proceed?
❯ 1. Yes
  2. Yes, and always allow access to tmp/ from this project
  3. No

Esc to cancel · Tab to add additional instructions
`;
  const result = detectPermissionPrompt(standardOutput);
  assert.notEqual(result, null);
  assert.equal(result?.tool, 'Bash');
  assert.equal(result?.options.length, 3);
  assert.equal(result?.options[0].label, 'Yes');
  assert.equal(result?.options[1].number, '2');

  // Plan mode prompt
  const planOutput = `
· Bash(prompt: run TypeScript compiler)
Would you like to proceed?

  1. Yes, and bypass permissions
❯ 2. Yes, and manually approve edits
  3. Type here to tell Claude what to change

ctrl-g to edit in Vim · ~/.claude/plans/...
`;
  const planResult = detectPermissionPrompt(planOutput);
  assert.notEqual(planResult, null);
  assert.equal(planResult?.tool, 'Bash');
  assert.equal(planResult?.options.length, 3);
  assert.equal(planResult?.options[1].label, 'Yes, and manually approve edits');

  // False positive (no footer/selector)
  const falsePositive = `
Do you want to proceed?
1. Yes
2. No
`;
  assert.equal(detectPermissionPrompt(falsePositive), null);
});
