const { Transform } = require('stream');

const FADE_TYPES = {
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  LOGARITHMIC: 'logarithmic',
  QUADRATIC: 'quadratic'
};

const DEFAULT_FADE_CONFIG = {
  enabled: true,
  fadeInDuration: 2.0,
  fadeOutDuration: 2.0,
  crossfadeDuration: 1.0,
  fadeType: FADE_TYPES.LINEAR,
  preFadeOutStart: 3.0
};

function calculateFadeVolume(progress, fadeType, isFadeIn = true) {
  const p = Math.max(0, Math.min(1, progress));
  
  switch (fadeType) {
    case FADE_TYPES.EXPONENTIAL:
      return isFadeIn 
        ? (Math.pow(2, p) - 1) 
        : (Math.pow(2, 1 - p) - 1);
    
    case FADE_TYPES.LOGARITHMIC:
      if (isFadeIn) {
        return p === 0 ? 0 : Math.log10(1 + 9 * p);
      } else {
        return p === 1 ? 0 : Math.log10(1 + 9 * (1 - p));
      }
    
    case FADE_TYPES.QUADRATIC:
      return isFadeIn 
        ? p * p 
        : (1 - p) * (1 - p);
    
    case FADE_TYPES.LINEAR:
    default:
      return isFadeIn ? p : 1 - p;
  }
}

function generateFFmpegFadeFilters(config, trackDuration, startTime = 0) {
  if (!config || !config.enabled) {
    return [];
  }

  const filters = [];
  const { fadeInDuration, fadeOutDuration, crossfadeDuration, fadeType, preFadeOutStart } = config;

  let fadeCurve = 'tri';
  switch (fadeType) {
    case FADE_TYPES.EXPONENTIAL:
      fadeCurve = 'exp';
      break;
    case FADE_TYPES.LOGARITHMIC:
      fadeCurve = 'log';
      break;
    case FADE_TYPES.QUADRATIC:
      fadeCurve = 'par';
      break;
    case FADE_TYPES.LINEAR:
    default:
      fadeCurve = 'tri';
  }

  if (fadeInDuration > 0 && startTime === 0) {
    filters.push({
      filter: 'afade',
      options: {
        t: 'in',
        st: 0,
        d: fadeInDuration,
        curve: fadeCurve
      }
    });
  }

  if (fadeOutDuration > 0 && trackDuration > 0) {
    const fadeOutStart = Math.max(0, trackDuration - fadeOutDuration - preFadeOutStart);
    filters.push({
      filter: 'afade',
      options: {
        t: 'out',
        st: fadeOutStart,
        d: fadeOutDuration,
        curve: fadeCurve
      }
    });
  }

  return filters;
}

function generateFFmpegVolumeExpression(config, currentTime, trackDuration, baseVolume = 1.0) {
  if (!config || !config.enabled) {
    return baseVolume.toString();
  }

  const { fadeInDuration, fadeOutDuration, fadeType, preFadeOutStart } = config;
  let volume = 1.0;

  if (currentTime < fadeInDuration) {
    const progress = currentTime / fadeInDuration;
    volume = calculateFadeVolume(progress, fadeType, true);
  } else if (trackDuration > 0 && currentTime > (trackDuration - fadeOutDuration - preFadeOutStart)) {
    const fadeOutStart = trackDuration - fadeOutDuration - preFadeOutStart;
    const progress = (currentTime - fadeOutStart) / fadeOutDuration;
    volume = calculateFadeVolume(progress, fadeType, false);
  }

  return `volume=${(volume * baseVolume).toFixed(4)}`;
}

class FadeTransform extends Transform {
  constructor(config, trackDuration, sampleRate = 44100, channels = 2, bitDepth = 16) {
    super();
    this.config = config || DEFAULT_FADE_CONFIG;
    this.trackDuration = trackDuration;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitDepth = bitDepth;
    this.bytesPerSample = bitDepth / 8;
    this.bytesPerFrame = this.bytesPerSample * channels;
    this.totalBytesProcessed = 0;
    this.baseVolume = 1.0;
    this.currentVolume = 0;
  }

  _transform(chunk, encoding, callback) {
    if (!this.config.enabled || !this.trackDuration || this.trackDuration <= 0) {
      this.push(chunk);
      this.totalBytesProcessed += chunk.length;
      return callback();
    }

    const { fadeInDuration, fadeOutDuration, fadeType, preFadeOutStart } = this.config;
    const totalFrames = this.trackDuration * this.sampleRate;
    const totalBytes = totalFrames * this.bytesPerFrame;
    
    const startFrame = this.totalBytesProcessed / this.bytesPerFrame;
    const endFrame = (this.totalBytesProcessed + chunk.length) / this.bytesPerFrame;
    const currentStartTime = startFrame / this.sampleRate;
    const currentEndTime = endFrame / this.sampleRate;

    let startVolume = this.baseVolume;
    let endVolume = this.baseVolume;

    if (currentStartTime < fadeInDuration) {
      const progress = currentStartTime / fadeInDuration;
      startVolume *= calculateFadeVolume(progress, fadeType, true);
    }
    if (currentEndTime < fadeInDuration) {
      const progress = currentEndTime / fadeInDuration;
      endVolume *= calculateFadeVolume(progress, fadeType, true);
    }

    if (this.trackDuration > 0) {
      const fadeOutStart = this.trackDuration - fadeOutDuration - preFadeOutStart;
      
      if (currentStartTime > fadeOutStart) {
        const progress = (currentStartTime - fadeOutStart) / fadeOutDuration;
        startVolume *= calculateFadeVolume(progress, fadeType, false);
      }
      if (currentEndTime > fadeOutStart) {
        const progress = (currentEndTime - fadeOutStart) / fadeOutDuration;
        endVolume *= calculateFadeVolume(progress, fadeType, false);
      }
    }

    this.currentVolume = (startVolume + endVolume) / 2;

    const processedChunk = this._applyVolumeRamp(chunk, startVolume, endVolume);
    
    this.push(processedChunk);
    this.totalBytesProcessed += chunk.length;
    callback();
  }

  _applyVolumeRamp(chunk, startVolume, endVolume) {
    const sampleCount = chunk.length / this.bytesPerSample;
    const result = Buffer.alloc(chunk.length);
    
    for (let i = 0; i < sampleCount; i++) {
      const progress = i / sampleCount;
      const volume = startVolume + (endVolume - startVolume) * progress;
      
      let sample;
      if (this.bitDepth === 16) {
        sample = chunk.readInt16LE(i * this.bytesPerSample);
        sample = Math.round(sample * volume);
        sample = Math.max(-32768, Math.min(32767, sample));
        result.writeInt16LE(sample, i * this.bytesPerSample);
      } else if (this.bitDepth === 32) {
        sample = chunk.readInt32LE(i * this.bytesPerSample);
        sample = Math.round(sample * volume);
        sample = Math.max(-2147483648, Math.min(2147483647, sample));
        result.writeInt32LE(sample, i * this.bytesPerSample);
      } else if (this.bitDepth === 24) {
        sample = (chunk.readUInt8(i * 3) | 
                 (chunk.readUInt8(i * 3 + 1) << 8) | 
                 (chunk.readInt8(i * 3 + 2) << 16));
        sample = Math.round(sample * volume);
        sample = Math.max(-8388608, Math.min(8388607, sample));
        result.writeUInt8(sample & 0xFF, i * 3);
        result.writeUInt8((sample >> 8) & 0xFF, i * 3 + 1);
        result.writeInt8(sample >> 16, i * 3 + 2);
      }
    }
    
    return result;
  }

  setBaseVolume(volume) {
    this.baseVolume = Math.max(0, Math.min(1, volume));
  }

  getCurrentVolume() {
    return this.currentVolume;
  }
}

function validateFadeConfig(config) {
  const errors = [];
  
  if (!config) {
    return ['配置不能为空'];
  }

  if (config.fadeInDuration !== undefined) {
    if (typeof config.fadeInDuration !== 'number' || config.fadeInDuration < 0) {
      errors.push('淡入时长必须是大于等于0的数字');
    }
    if (config.fadeInDuration > 10) {
      errors.push('淡入时长不能超过10秒');
    }
  }

  if (config.fadeOutDuration !== undefined) {
    if (typeof config.fadeOutDuration !== 'number' || config.fadeOutDuration < 0) {
      errors.push('淡出时长必须是大于等于0的数字');
    }
    if (config.fadeOutDuration > 10) {
      errors.push('淡出时长不能超过10秒');
    }
  }

  if (config.crossfadeDuration !== undefined) {
    if (typeof config.crossfadeDuration !== 'number' || config.crossfadeDuration < 0) {
      errors.push('交叉淡入淡出时长必须是大于等于0的数字');
    }
    if (config.crossfadeDuration > 5) {
      errors.push('交叉淡入淡出时长不能超过5秒');
    }
  }

  if (config.preFadeOutStart !== undefined) {
    if (typeof config.preFadeOutStart !== 'number' || config.preFadeOutStart < 0) {
      errors.push('预淡出开始时间必须是大于等于0的数字');
    }
  }

  if (config.fadeType !== undefined) {
    if (!Object.values(FADE_TYPES).includes(config.fadeType)) {
      errors.push(`淡入淡出类型必须是以下之一: ${Object.values(FADE_TYPES).join(', ')}`);
    }
  }

  if (config.enabled !== undefined) {
    if (typeof config.enabled !== 'boolean') {
      errors.push('enabled 必须是布尔值');
    }
  }

  return errors;
}

function mergeFadeConfig(baseConfig, newConfig) {
  return {
    ...baseConfig,
    ...newConfig
  };
}

module.exports = {
  FADE_TYPES,
  DEFAULT_FADE_CONFIG,
  calculateFadeVolume,
  generateFFmpegFadeFilters,
  generateFFmpegVolumeExpression,
  FadeTransform,
  validateFadeConfig,
  mergeFadeConfig
};
