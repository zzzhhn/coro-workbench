import type { SourceInfo } from './types';

export function pitchVerificationSummary(analysis: SourceInfo['analysis']) {
  const quality = analysis?.quality;
  if (!quality) return undefined;
  const seconds = (key: string) => {
    const value = quality[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const sampled = seconds('vocals.independentCheckSeconds');
  if (quality.verificationStatus === 'failed')
    return {
      title: '完整音高校验未完成',
      detail: '当前只保留已有谱面提案与抽样证据，不视为已完整核对。可下载模型证据查看错误后重试。',
    };
  if (quality.verificationStatus === 'not_applicable')
    return {
      title: '此结果没有完整主唱核对',
      detail: '缺少可核对的独立主唱音频或连续音高；不适用不代表没有错音。',
    };
  const verified = seconds('vocals.denseVerifiedSeconds');
  if (verified !== undefined && verified > 0) {
    const joint = seconds('vocals.denseJointVoicedSeconds');
    const lowEvidence = seconds('vocals.denseLowEvidenceSeconds');
    const agreement = seconds('vocals.denseWithin50Cents');
    return {
      title: `${quality.verificationStatus === 'complete' ? '已完成分析段音高校验' : '保存的逐帧音高校验'} · ${verified.toFixed(1)} 秒`,
      detail: [
        joint !== undefined ? `其中 ${joint.toFixed(1)} 秒有共同发声证据。` : '',
        joint && agreement !== undefined && agreement <= 1
          ? `这部分帧的音高一致率为 ${(agreement * 100).toFixed(1)}%（误差不超过 50 音分）。`
          : '',
        lowEvidence !== undefined ? `${lowEvidence.toFixed(1)} 秒静音或低证据不计为正确。` : '',
        '模型一致不是音符准确率，也不证明主唱身份；核对不会自动改写音符。',
      ].join(''),
    };
  }
  if (sampled !== undefined && sampled > 0)
    return {
      title: `仅抽样音高校验 · ${sampled.toFixed(1)} 秒`,
      detail: '未抽样部分未核实。抽样中两个模型一致，也不能证明全段音符或主唱身份正确。',
    };
  if (quality.verificationMode)
    return {
      title: '尚无可用的独立音高校验证据',
      detail: '选择校验模式不等于校验已经完成；请对照原音频校正后再排练。',
    };
  return undefined;
}
