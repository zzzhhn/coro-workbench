import { describe, expect, it } from 'vitest';
import { pitchVerificationSummary } from '../src/lib/verificationSummary';
import type { SourceInfo } from '../src/lib/types';

const summary = (quality: NonNullable<SourceInfo['analysis']>['quality']) =>
  pitchVerificationSummary({ transforms: [], quality });

describe('independent verification evidence labels', () => {
  it('does not treat a requested full mode as completed evidence', () => {
    expect(summary({ verificationMode: 'full' })?.title).toContain('尚无');
    expect(pitchVerificationSummary(undefined)).toBeUndefined();
  });
  it('distinguishes frame agreement from note accuracy and silence', () => {
    const result = summary({
      verificationStatus: 'complete',
      'vocals.denseVerifiedSeconds': 8,
      'vocals.denseJointVoicedSeconds': 6,
      'vocals.denseWithin50Cents': 0.95,
      'vocals.denseLowEvidenceSeconds': 2,
    });
    expect(result?.title).toContain('已完成分析段');
    expect(result?.detail).toContain('95.0%');
    expect(result?.detail).toContain('2.0 秒静音或低证据不计为正确');
    expect(result?.detail).toContain('不是音符准确率');
  });
  it('retains historical dense evidence without inventing a current success status', () => {
    expect(summary({ 'vocals.denseVerifiedSeconds': 267.12 })?.title).toBe('保存的逐帧音高校验 · 267.1 秒');
  });
  it('labels reused evidence and unavailable verification separately after vocal rebuilding', () => {
    const cached = summary({ verificationStatus: 'prior_cached', 'vocals.denseVerifiedSeconds': 20 });
    expect(cached?.title).toContain('沿用原声');
    expect(cached?.detail).toContain('未重新运行');
    const missing = summary({ verificationStatus: 'not_rerun', 'vocals.denseVerifiedSeconds': 20 });
    expect(missing?.title).toBe('本次未重跑独立音高校验');
    expect(missing?.detail).not.toContain('20.0');
  });
  it.each(['failed', 'not_applicable'])('lets %s override older dense values', (status) => {
    const result = summary({ verificationStatus: status, 'vocals.denseVerifiedSeconds': 8 });
    expect(result?.title).not.toContain('已完成');
    expect(result?.title).not.toContain('逐帧');
  });
  it('does not report agreement for unvoiced clips or invalid values', () => {
    expect(
      summary({
        'vocals.denseVerifiedSeconds': 8,
        'vocals.denseJointVoicedSeconds': 0,
        'vocals.denseWithin50Cents': 1,
      })?.detail,
    ).not.toContain('%');
    expect(summary({ verificationMode: 'full', 'vocals.denseVerifiedSeconds': Infinity })?.title).toContain(
      '尚无',
    );
    expect(summary({ 'vocals.independentCheckSeconds': 9 })?.title).toBe('仅抽样音高校验 · 9.0 秒');
  });
});
