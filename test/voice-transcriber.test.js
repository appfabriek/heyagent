import assert from 'node:assert/strict';
import test from 'node:test';
import { formatVoiceTranscriberStatus } from '../src/voice-transcriber.js';

test('formatVoiceTranscriberStatus reports unavailable state with reason', () => {
  assert.equal(
    formatVoiceTranscriberStatus({
      available: false,
      reason: 'ffmpeg is not installed or not available on PATH.',
    }),
    'unavailable (ffmpeg is not installed or not available on PATH.)'
  );
});

test('formatVoiceTranscriberStatus reports enabled backend and model hint', () => {
  assert.equal(
    formatVoiceTranscriberStatus({
      available: true,
      backend: 'ffmpeg + whisper-cli',
      modelHint: 'auto (cached)',
    }),
    'enabled (ffmpeg + whisper-cli, model: auto (cached))'
  );
});
