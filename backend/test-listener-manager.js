const assert = require('assert');
const ListenerManager = require('./src/listener-manager');

let passed = 0;
let failed = 0;
const failures = [];
let pendingAsync = 0;
let finished = false;

function test(name, fn) {
  try {
    if (fn.length > 0) {
      pendingAsync++;
      const done = () => {
        pendingAsync--;
        passed++;
        console.log(`  ✓ ${name}`);
        checkFinished();
      };
      done.fail = (err) => {
        pendingAsync--;
        failed++;
        failures.push({ name, error: err || new Error('test failed') });
        console.log(`  ✗ ${name}`);
        console.log(`    ${(err && err.message) || err}`);
        checkFinished();
      };
      try {
        fn(done);
      } catch (e) {
        pendingAsync--;
        failed++;
        failures.push({ name, error: e });
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
        checkFinished();
      }
    } else {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

console.log('\n======== ListenerManager 单元测试 ========');

suite('基础计数功能', () => {
  const lm = new ListenerManager();

  test('初始状态计数为0', () => {
    assert.strictEqual(lm.getListenerCount('pop'), 0);
    assert.strictEqual(lm.getListenerCount('classic'), 0);
  });

  test('添加一个监听器后计数为1', () => {
    const id = lm.addListener('pop');
    assert.ok(id, '应返回 connectionId');
    assert.strictEqual(lm.getListenerCount('pop'), 1);
  });

  test('添加多个监听器后计数正确', () => {
    const id1 = lm.addListener('pop');
    const id2 = lm.addListener('classic');
    assert.strictEqual(lm.getListenerCount('pop'), 2);
    assert.strictEqual(lm.getListenerCount('classic'), 1);
  });

  test('removeListener 后计数减少', () => {
    const listeners = {};
    const events = [];
    const lm2 = new ListenerManager();
    lm2.on('listenersChange', (channel, count) => {
      events.push({ channel, count });
    });
    const id = lm2.addListener('pop');
    assert.strictEqual(lm2.getListenerCount('pop'), 1);
    lm2.removeListener('pop', id);
    assert.strictEqual(lm2.getListenerCount('pop'), 0);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].count, 1);
    assert.strictEqual(events[1].count, 0);
  });

  test('移除不存在的连接不报错', () => {
    const lm2 = new ListenerManager();
    lm2.addListener('pop');
    lm2.removeListener('pop', 'nonexistent-id');
    lm2.removeListener('nonexistent-channel', 'some-id');
    assert.strictEqual(lm2.getListenerCount('pop'), 1);
  });

  test('getAllCounts 返回所有频道计数', () => {
    const lm2 = new ListenerManager();
    lm2.addListener('pop');
    lm2.addListener('pop');
    lm2.addListener('classic');
    const counts = lm2.getAllCounts();
    assert.strictEqual(counts.pop, 2);
    assert.strictEqual(counts.classic, 1);
  });

  test('hasListeners 正确返回', () => {
    const lm2 = new ListenerManager();
    assert.strictEqual(lm2.hasListeners('pop'), false);
    lm2.addListener('pop');
    assert.strictEqual(lm2.hasListeners('pop'), true);
  });

  test('clearChannel 清空频道', () => {
    const lm2 = new ListenerManager();
    lm2.addListener('pop');
    lm2.addListener('pop');
    lm2.clearChannel('pop');
    assert.strictEqual(lm2.getListenerCount('pop'), 0);
  });
});

suite('userId & 用户去重功能', () => {
  test('addListener 支持 userId 参数', () => {
    const lm = new ListenerManager();
    const id1 = lm.addListener('pop', 'user-1');
    const id2 = lm.addListener('pop', 'user-1');
    assert.strictEqual(lm.getListenerCount('pop'), 2);
  });

  test('removeAllForUser 按用户移除全部连接', () => {
    const lm = new ListenerManager();
    lm.addListener('pop', 'user-1');
    lm.addListener('pop', 'user-1');
    lm.addListener('classic', 'user-1');
    lm.addListener('pop', 'user-2');

    assert.strictEqual(lm.getListenerCount('pop'), 3);
    assert.strictEqual(lm.getListenerCount('classic'), 1);

    const affected = lm.removeAllForUser('user-1');
    assert.ok(affected.has('pop'));
    assert.ok(affected.has('classic'));

    assert.strictEqual(lm.getListenerCount('pop'), 1);
    assert.strictEqual(lm.getListenerCount('classic'), 0);
  });

  test('removeListener 时正确清理 userConnections', () => {
    const lm = new ListenerManager();
    const id = lm.addListener('pop', 'user-1');
    lm.removeListener('pop', id);
    assert.strictEqual(lm.getListenerCount('pop'), 0);
  });
});

suite('心跳 & 超时清理功能', () => {
  test('touch 更新连接的活跃时间', () => {
    const lm = new ListenerManager();
    const id = lm.addListener('pop');
    const info1 = lm.getConnectionInfo(id, 'pop');
    const before = info1.lastActiveAt;
    const start = Date.now();
    while (Date.now() - start < 10) {}
    lm.touch(id, 'pop');
    const info2 = lm.getConnectionInfo(id, 'pop');
    assert.ok(info2.lastActiveAt >= before);
  });

  test('removeStaleConnections 清理超时连接', () => {
    const lm = new ListenerManager({ timeoutMs: 30000, checkIntervalMs: 99999 });
    const id1 = lm.addListener('pop');
    const id2 = lm.addListener('pop');
    const info1 = lm.getConnectionInfo(id1, 'pop');
    const info2 = lm.getConnectionInfo(id2, 'pop');
    info1.lastActiveAt = Date.now() - 60000;
    info2.lastActiveAt = Date.now();
    const removed = lm.removeStaleConnections();
    assert.strictEqual(removed.length, 1, `预期移除1个，实际移除${removed.length}`);
    assert.strictEqual(lm.getListenerCount('pop'), 1);
  });

  test('自动后台定时清理超时连接', (done) => {
    const lm = new ListenerManager({ timeoutMs: 20, checkIntervalMs: 30 });
    lm.addListener('pop');
    lm.addListener('pop');
    const infoMap = lm.channelListeners.get('pop');
    for (const info of infoMap.values()) {
      info.lastActiveAt = Date.now() - 60000;
    }
    assert.strictEqual(lm.getListenerCount('pop'), 2);
    setTimeout(() => {
      assert.strictEqual(lm.getListenerCount('pop'), 0, `超时后应被清理为0，实际为${lm.getListenerCount('pop')}`);
      lm._stopStaleCheck();
      done();
    }, 150);
  });
});

suite('事件机制', () => {
  test('addListener 触发 listenersChange 事件', () => {
    const lm = new ListenerManager();
    const events = [];
    lm.on('listenersChange', (ch, count) => events.push({ ch, count }));
    lm.addListener('pop');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].ch, 'pop');
    assert.strictEqual(events[0].count, 1);
  });

  test('removeListener 触发 listenersChange 事件', () => {
    const lm = new ListenerManager();
    const events = [];
    lm.on('listenersChange', (ch, count) => events.push(count));
    const id = lm.addListener('pop');
    lm.removeListener('pop', id);
    assert.strictEqual(events[events.length - 1], 0);
  });

  test('shutdown 触发所有频道归零事件', () => {
    const lm = new ListenerManager();
    const events = [];
    lm.on('listenersChange', (ch, count) => events.push({ ch, count }));
    lm.addListener('pop');
    lm.addListener('classic');
    lm.shutdown();
    const lastPop = events.filter(e => e.ch === 'pop').slice(-1)[0];
    const lastClassic = events.filter(e => e.ch === 'classic').slice(-1)[0];
    assert.strictEqual(lastPop.count, 0);
    assert.strictEqual(lastClassic.count, 0);
  });
});

suite('shutdown & 资源清理', () => {
  test('shutdown 清空所有数据', () => {
    const lm = new ListenerManager();
    lm.addListener('pop', 'u1');
    lm.addListener('pop', 'u2');
    lm.addListener('classic', 'u1');
    lm.shutdown();
    assert.strictEqual(lm.getListenerCount('pop'), 0);
    assert.strictEqual(lm.getListenerCount('classic'), 0);
    assert.deepStrictEqual(lm.getAllCounts(), {});
  });

  test('shutdown 后再添加监听器仍正常工作', () => {
    const lm = new ListenerManager();
    lm.addListener('pop');
    lm.shutdown();
    const id = lm.addListener('pop');
    assert.ok(id);
    assert.strictEqual(lm.getListenerCount('pop'), 1);
    lm.shutdown();
  });
});

suite('真实场景模拟', () => {
  test('模拟用户刷新页面：leave → 新add，最终人数正确', () => {
    const lm = new ListenerManager();
    const userId = 'user-refresh';

    const id1 = lm.addListener('pop', userId);
    assert.strictEqual(lm.getListenerCount('pop'), 1);

    lm.removeAllForUser(userId);
    assert.strictEqual(lm.getListenerCount('pop'), 0);

    const id2 = lm.addListener('pop', userId);
    assert.strictEqual(lm.getListenerCount('pop'), 1);
    assert.notStrictEqual(id1, id2);
  });

  test('模拟多用户同时在线：3用户各1连接 → 3', () => {
    const lm = new ListenerManager();
    lm.addListener('pop', 'u1');
    lm.addListener('pop', 'u2');
    lm.addListener('pop', 'u3');
    assert.strictEqual(lm.getListenerCount('pop'), 3);
    assert.strictEqual(lm.getUniqueUserCount('pop'), 3);
  });

  test('模拟同用户开多个标签页：1用户3连接 → 计数3，去重用户数1', () => {
    const lm = new ListenerManager();
    lm.addListener('pop', 'u-multi');
    lm.addListener('pop', 'u-multi');
    lm.addListener('pop', 'u-multi');
    assert.strictEqual(lm.getListenerCount('pop'), 3);
    assert.strictEqual(lm.getUniqueUserCount('pop'), 1);
  });

  test('模拟页面关闭不触发事件但超时自动清理', () => {
    const lm = new ListenerManager({ timeoutMs: 40, checkIntervalMs: 99999 });
    lm.addListener('pop', 'u-close');
    lm.addListener('pop', 'u-close');
    const infoMap = lm.channelListeners.get('pop');
    for (const info of infoMap.values()) {
      info.lastActiveAt = Date.now() - 60000;
    }
    assert.strictEqual(lm.getListenerCount('pop'), 2);
    const removed = lm.removeStaleConnections();
    assert.strictEqual(removed.length, 2);
    assert.strictEqual(lm.getListenerCount('pop'), 0);
  });
});

function checkFinished() {
  if (finished) return;
  if (pendingAsync === 0) {
    finished = true;
    console.log(`\n======== 测试结果 ========`);
    console.log(`通过: ${passed}`);
    console.log(`失败: ${failed}`);
    if (failures.length > 0) {
      console.log(`\n失败详情:`);
      for (const f of failures) {
        console.log(`  - ${f.name}`);
        console.log(`    ${f.error.stack}`);
      }
      process.exit(1);
    } else {
      console.log(`\n🎉 所有测试通过！`);
      process.exit(0);
    }
  }
}

setTimeout(() => {
  if (pendingAsync === 0) {
    checkFinished();
  } else {
    setTimeout(() => checkFinished(), 500);
  }
}, 100);
