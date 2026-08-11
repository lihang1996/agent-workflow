import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskStore } from './task-store.js';

test('complete marks the requested task as completed and returns it', () => {
  const store = new TaskStore();
  store.add('task-1', 'Write tests');

  const completedTask = store.complete('task-1');

  assert.deepEqual(completedTask, {
    id: 'task-1',
    title: 'Write tests',
    completed: true,
  });
  assert.deepEqual(store.list(), [completedTask]);
});

test('complete is idempotent', () => {
  const store = new TaskStore();
  store.add('task-1', 'Write tests');

  const firstResult = store.complete('task-1');
  const secondResult = store.complete('task-1');

  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(store.list(), [firstResult]);
});

test('complete throws an error containing the task ID when the task is missing', () => {
  const store = new TaskStore();

  assert.throws(() => store.complete('missing-task'), /missing-task/);
});

test('complete does not change other tasks', () => {
  const store = new TaskStore();
  store.add('task-1', 'Write tests');
  store.add('task-2', 'Review changes');

  store.complete('task-1');

  assert.deepEqual(store.list(), [
    { id: 'task-1', title: 'Write tests', completed: true },
    { id: 'task-2', title: 'Review changes', completed: false },
  ]);
});
