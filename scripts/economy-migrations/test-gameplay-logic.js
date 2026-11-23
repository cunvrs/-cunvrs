
import assert from 'node:assert/strict';
import { score } from '../../src/commands/Economy/wordle.js';
import { line3, line4 } from '../../src/commands/Economy/modules/boardGames.js';

const check = (name, test) => {
  test();
  console.log(`PASS: ${name}`);
};

console.log('\n=== WORDLE SCORING ===');

check('All letters correct', () => {
  assert.equal(score('APPLE', 'APPLE'), '🟩🟩🟩🟩🟩');
});

check('All letters incorrect', () => {
  assert.equal(score('APPLE', 'MIGHT'), '⬛⬛⬛⬛⬛');
});

check('Misplaced letters', () => {
  assert.equal(score('PEACH', 'APPLE'), '🟨🟨⬛⬛🟨');
});

check('Repeated letters', () => {
  assert.equal(score('APPLE', 'PEARL'), '🟨🟨🟨⬛🟨');
});

console.log('\n=== TIC-TAC-TOE ===');

function tic(positions) {
  const cells = Array(9).fill(-1);
  for (const [index, player] of positions) {
    cells[index] = player;
  }
  return cells;
}

check('Horizontal win', () => {
  assert.equal(line3(tic([[0,0],[1,0],[2,0]]), 0), true);
});

check('Vertical win', () => {
  assert.equal(line3(tic([[0,1],[3,1],[6,1]]), 1), true);
});

check('Diagonal win', () => {
  assert.equal(line3(tic([[2,0],[4,0],[6,0]]), 0), true);
});

check('Mixed pieces are not a win', () => {
  assert.equal(line3(tic([[0,0],[1,1],[2,0]]), 0), false);
});

check('Empty board is not a win', () => {
  assert.equal(line3(Array(9).fill(-1), 0), false);
});

console.log('\n=== FOUR IN A ROW ===');

function four(positions) {
  const board = Array.from(
    { length: 6 },
    () => Array(7).fill(-1)
  );

  for (const [row, column, player] of positions) {
    board[row][column] = player;
  }

  return board;
}

check('Horizontal win', () => {
  assert.equal(line4(four([
    [5,0,0],[5,1,0],[5,2,0],[5,3,0]
  ]), 0), true);
});

check('Vertical win', () => {
  assert.equal(line4(four([
    [5,1,1],[4,1,1],[3,1,1],[2,1,1]
  ]), 1), true);
});

check('Diagonal down-right win', () => {
  assert.equal(line4(four([
    [2,0,0],[3,1,0],[4,2,0],[5,3,0]
  ]), 0), true);
});

check('Diagonal down-left win', () => {
  assert.equal(line4(four([
    [2,6,1],[3,5,1],[4,4,1],[5,3,1]
  ]), 1), true);
});

check('Three pieces are not a win', () => {
  assert.equal(line4(four([
    [5,0,0],[5,1,0],[5,2,0]
  ]), 0), false);
});

check('Mixed pieces are not a win', () => {
  assert.equal(line4(four([
    [5,0,0],[5,1,0],[5,2,1],[5,3,0]
  ]), 0), false);
});

console.log('\nALL GAMEPLAY LOGIC TESTS PASSED!');
