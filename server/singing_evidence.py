"""Audio evidence for singing-score inference, shared by review and upload paths."""
import numpy as np

def acoustic_evidence(wave, sr, contour):
    def energy(a,b):
        x=wave[max(0,round(a*sr)):max(0,round(b*sr))]
        return float(np.sqrt(np.mean(x*x)+1e-12)) if len(x) else 0.
    def attack(at):
        before,at_energy,after=energy(at-.06,at-.02),energy(at-.012,at+.012),energy(at+.02,at+.06)
        return at_energy<max(before,after)*.5 or after>max(before,1e-6)*1.8
    with np.load(contour,allow_pickle=False) as stored:
        times=stored['time'];activation=stored['activation'];f0=stored['f0']
    pitches=69+12*np.log2(np.maximum(f0,1)/440)
    def pitch_support(start,end,midi):
        mask=(times>=start)&(times<end)
        valid=mask&(activation>=.5)&np.isfinite(pitches)&(f0>0)
        # A GAME gate can include the next consonant. Judge the supported vowel
        # frames, not the unvoiced tail; sparse/mostly unvoiced intervals abstain.
        if valid.sum()<8 or valid.sum()<mask.sum()*.35:return 0.
        # FCPE can halve the high sung fundamental; GAME still supplies octave.
        # Pitch-class support here only validates retained GAME body pitches.
        distance=abs((pitches[valid]-midi+6)%12-6)
        support=float(np.mean(distance<=.5))
        core=valid&(times<start+.14)
        if core.sum()>=8:
            support=max(support,float(np.mean(abs((pitches[core]-midi+6)%12-6)<=.5)))
        return support
    def structural_attack(at):
        if not attack(at):return False
        before=(times>=at-.04)&(times<at+.01)
        return before.sum()<3 or float(np.mean(activation[before]<.5))>=.4
    def pitch_runs(start,end,anchor):
        from scipy.ndimage import median_filter
        indices=np.flatnonzero((times>=start)&(times<end))
        if not len(indices):return []
        pitch=anchor+(pitches[indices]-anchor+6)%12-6
        smooth=median_filter(pitch,size=3,mode='nearest');rounded=np.rint(smooth)
        valid=(activation[indices]>=.5)&(f0[indices]>0)&(abs(smooth-rounded)<=.4)
        runs=[];begin=None
        for k in range(len(indices)+1):
            continuing=(k<len(indices) and valid[k] and begin is not None and rounded[k]==rounded[begin])
            if begin is not None and not continuing:
                runs.append({'start':float(times[indices[begin]]),'end':float(times[indices[k-1]]+.01),
                    'midi':int(rounded[begin]),'support':float(np.mean(abs(pitch[begin:k]-rounded[begin])<=.5))})
                begin=None
            if k<len(indices) and valid[k] and begin is None:begin=k
        return runs
    def contour_pitch(start,end):
        valid=(times>=start+.02)&(times<end-.01)&(activation>=.5)&(f0>0)&np.isfinite(pitches)
        if valid.sum()<8:return None
        return float(np.median(pitches[valid]))
    def short_contour_support(start,end,midi):
        mask=(times>=start)&(times<end)
        valid=mask&(activation>=.5)&(f0>0)
        if valid.sum()<4 or valid.sum()<mask.sum()*.8:return 0.
        return float(np.mean(abs((pitches[valid]-midi+6)%12-6)<=.5))
    def onset_pitch_spread(start,end):
        mask=(times>=start)&(times<end)
        valid=mask&(activation>=.5)&np.isfinite(pitches)&(f0>0)
        if valid.sum()<8 or valid.sum()<mask.sum()*.65:return None
        low,high=np.percentile(pitches[valid],[10,90])
        return float(high-low)
    return {name: value for name, value in locals().items() if callable(value)}
