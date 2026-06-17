const http = require('http');
const { 
  FADE_TYPES, 
  DEFAULT_FADE_CONFIG, 
  calculateFadeVolume,
  generateFFmpegFadeFilters,
  validateFadeConfig,
  mergeFadeConfig
} = require('../src/fade-processor');

console.log('=== 音频淡入淡出功能测试 ===\n');

console.log('1. 测试淡入淡出曲线计算...');
console.log('   支持的渐变类型:', Object.values(FADE_TYPES));

for (const type of Object.values(FADE_TYPES)) {
  console.log(`\n   ${type} 曲线测试:`);
  for (let i = 0; i <= 5; i++) {
    const progress = i * 0.2;
    const fadeInVol = calculateFadeVolume(progress, type, true);
    const fadeOutVol = calculateFadeVolume(progress, type, false);
    console.log(`     progress ${progress.toFixed(1)}: 淡入=${fadeInVol.toFixed(4)}, 淡出=${fadeOutVol.toFixed(4)}`);
  }
}

console.log('\n2. 测试配置验证...');
const validConfig = {
  enabled: true,
  fadeInDuration: 2.5,
  fadeOutDuration: 2.5,
  crossfadeDuration: 1.0,
  fadeType: FADE_TYPES.EXPONENTIAL,
  preFadeOutStart: 3.0
};

let errors = validateFadeConfig(validConfig);
console.log('   有效配置验证结果:', errors.length === 0 ? '通过' : '失败: ' + errors.join(', '));

const invalidConfig = {
  fadeInDuration: -1,
  fadeType: 'invalid_type'
};
errors = validateFadeConfig(invalidConfig);
console.log('   无效配置验证结果:', errors.length > 0 ? '正确检测到错误: ' + errors.join(', ') : '失败: 未检测到错误');

console.log('\n3. 测试配置合并...');
const merged = mergeFadeConfig(DEFAULT_FADE_CONFIG, { fadeInDuration: 5.0 });
console.log('   合并后 fadeInDuration:', merged.fadeInDuration);
console.log('   合并后 fadeType:', merged.fadeType);

console.log('\n4. 测试 FFmpeg 滤镜生成...');
const filters = generateFFmpegFadeFilters(validConfig, 180, 0);
console.log('   生成的滤镜数量:', filters.length);
filters.forEach((f, i) => {
  console.log(`   滤镜 ${i + 1}: ${f.filter}`, f.options);
});

console.log('\n5. 测试 API 接口...');

function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testAPI() {
  try {
    console.log('\n   5.1 获取默认淡入淡出配置...');
    const defaultRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/fade/default',
      method: 'GET'
    });
    console.log('     状态:', defaultRes.status);
    console.log('     配置:', defaultRes.data);

    console.log('\n   5.2 获取 pop 频道淡入淡出配置...');
    const getRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/channels/pop/fade',
      method: 'GET'
    });
    console.log('     状态:', getRes.status);
    console.log('     配置:', getRes.data);

    console.log('\n   5.3 更新 pop 频道淡入淡出配置...');
    const updateRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/channels/pop/fade',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      fadeInDuration: 3.0,
      fadeOutDuration: 3.0,
      fadeType: 'exponential'
    });
    console.log('     状态:', updateRes.status);
    console.log('     结果:', updateRes.data);

    console.log('\n   5.4 验证配置更新...');
    const verifyRes = await makeRequest({
      hostname: 'localhost',
      port: 3000,
      path: '/api/channels/pop/fade',
      method: 'GET'
    });
    console.log('     fadeInDuration:', verifyRes.data.fadeInDuration);
    console.log('     fadeOutDuration:', verifyRes.data.fadeOutDuration);
    console.log('     fadeType:', verifyRes.data.fadeType);

    console.log('\n=== 所有测试完成 ===');

  } catch (e) {
    console.error('   API 测试失败:', e.message);
    console.log('   请确保服务器已启动: npm start');
  }
}

testAPI();
