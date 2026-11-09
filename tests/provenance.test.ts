import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { pipelineStatus } from '../src/lib/provenance';

describe('transcription provenance', () => {
  it('flags legacy audio transcriptions and accepts current ones', () => {
    const project = createBlankProject();
    expect(pipelineStatus(project).kind).toBe('not-audio');
    project.source = { kind: 'audio', warnings: [], engine: 'Demucs 4.0.1 / htdemucs_6s + Basic Pitch 0.4.0 (ONNX)',
      analysis: { transforms: [], quality: { decoderProfile: 'acoustic' } } };
    expect(pipelineStatus(project)).toEqual({ kind: 'legacy', reason: 'Basic Pitch 分轨转写' });
    project.source.engine = 'YourMT3+ YPTF.MoE+Multi noPS (local CPU, experimental) + Demucs / GAME Medium 8 steps';
    project.source.analysis!.quality = { decoderProfile: 'game' };
    expect(pipelineStatus(project)).toEqual({ kind: 'legacy', reason: '旧版流水线' });
    project.source.pipeline = { generation: 'v5', revision: 'abc123' };
    expect(pipelineStatus(project)).toEqual({ kind: 'current', revision: 'abc123' });
  });
});
