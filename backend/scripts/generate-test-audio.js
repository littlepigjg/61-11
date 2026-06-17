const fs = require('fs');
const path = require('path');

function generateWavFile(filename, frequency, duration, sampleRate = 44100) {
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = sampleRate * duration * numChannels * (bitsPerSample / 8);
  const fileSize = 44 + dataSize - 8;

  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const amplitude = 0.3 * 32767;
  for (let i = 0; i < sampleRate * duration; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    const envelope = Math.min(1, Math.min(t * 2, (duration - t) * 2));
    const val = Math.floor(sample * envelope);

    const offset = 44 + i * 4;
    buffer.writeInt16LE(val, offset);
    buffer.writeInt16LE(val, offset + 2);
  }

  fs.writeFileSync(filename, buffer);
  console.log(`Generated: ${filename}`);
}

const musicDir = path.join(__dirname, '../music');

const popDir = path.join(musicDir, 'pop');
generateWavFile(path.join(popDir, '歌曲1-阳光午后.wav'), 440, 8);
generateWavFile(path.join(popDir, '歌曲2-城市节拍.wav'), 523, 10);
generateWavFile(path.join(popDir, '歌曲3-夏日恋歌.wav'), 392, 7);
generateWavFile(path.join(popDir, '歌曲4-星空漫步.wav'), 330, 12);
generateWavFile(path.join(popDir, '歌曲5-梦想起航.wav'), 587, 9);

const classicDir = path.join(musicDir, 'classic');
generateWavFile(path.join(classicDir, '乐章1-月光奏鸣曲.wav'), 261, 15);
generateWavFile(path.join(classicDir, '乐章2-小夜曲.wav'), 293, 12);
generateWavFile(path.join(classicDir, '乐章3-田园交响曲.wav'), 329, 18);
generateWavFile(path.join(classicDir, '乐章4-蓝色多瑙河.wav'), 349, 14);

const electronicDir = path.join(musicDir, 'electronic');
generateWavFile(path.join(electronicDir, '电音1-脉冲节奏.wav'), 130, 6);
generateWavFile(path.join(electronicDir, '电音2-未来科技.wav'), 165, 8);
generateWavFile(path.join(electronicDir, '电音3-赛博朋克.wav'), 110, 10);
generateWavFile(path.join(electronicDir, '电音4-太空漫游.wav'), 196, 12);
generateWavFile(path.join(electronicDir, '电音5-数字梦境.wav'), 220, 9);

console.log('\n测试音频文件生成完成！');
console.log(`音乐目录: ${musicDir}`);
