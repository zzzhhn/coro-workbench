import copy
import unittest

from server.singing_score import (abstract_syllables, abstract_unworded_approaches, estimate_vocal_phase,
    infer_score_rhythm, resolve_chunk_seams, resolve_pitch_edges, restore_contour_tails,
    recover_short_syllable_anchors, mark_legato_transitions)


def event(name, start, end, midi, word=None, lyric=None):
    e = dict(id=name, start=start, end=end, midi=midi, sourceIds=[name])
    if word: e['wordId'] = word
    if lyric: e['lyric'] = lyric
    return e


class SingingScoreTests(unittest.TestCase):
    def test_short_vowel_can_use_an_existing_attack_but_not_a_collapsed_alignment(self):
        words=[dict(id='a',start=1,end=1.154,vowelStart=1.131,
                    phones=[dict(posterior=.12),dict(posterior=.04)])]
        events=[event('a',1.12,1.5,67)]
        rows,audit=recover_short_syllable_anchors(events,words)
        self.assertEqual(rows[0]['vowelStart'],1.12)
        self.assertEqual(len(audit),1)
        collapsed=[dict(words[0],end=1.134)]
        self.assertEqual(recover_short_syllable_anchors(events,collapsed)[0],collapsed)
        self.assertEqual(recover_short_syllable_anchors([event('b',1.3,1.5,67)],words)[0],words)

    def abstract(self, events, attack=False):
        return abstract_syllables(events, seconds_per_beat=1,
            attack_at=lambda _: attack, pitch_support=lambda *_: .96,
            onset_pitch_spread=lambda *_: .25)

    def test_short_approach_and_tail_anticipation_leave_the_next_word(self):
        events = [event('a',1,1.15,67,'a','甲'),event('b',1.15,1.5,69,'a'),
                  event('c',1.5,1.67,62,'b','乙'),event('d',1.67,2,61,'b'),
                  event('e',2,2.5,61,'c','丙')]
        original = copy.deepcopy(events)
        rows, audit = self.abstract(events)
        self.assertEqual([(e['midi'],e['start'],e['end']) for e in rows],[(69,1,1.5),(62,1.5,2),(61,2,2.5)])
        self.assertEqual(events, original)
        self.assertEqual(len(audit),2)

    def test_real_short_melisma_new_attacks_and_multi_note_figures_survive(self):
        events = [event('a',1,1.24,64,'a','甲'),event('b',1.24,1.5,66,'a')]
        self.assertEqual(self.abstract(events)[0],events)
        quick = [dict(events[0],end=1.14),dict(events[1],start=1.14)]
        self.assertEqual(self.abstract(quick,True)[0],quick)
        three = quick+[event('c',1.5,1.7,64,'a')]
        self.assertEqual(self.abstract(three)[0],three)

    def test_long_dominant_body_can_absorb_a_brief_stable_approach(self):
        events=[event('a',1,1.21,62,'a','甲'),event('b',1.21,2,64,'a')]
        self.assertEqual([e['midi'] for e in self.abstract(events)[0]],[64])

    def test_repeated_syllable_approaches_keep_two_attacks_and_final_melisma(self):
        events=[event('a',1,1.24,64,'a','甲'),event('b',1.24,1.5,66,'a'),
                event('c',1.5,1.73,64,'b','乙'),event('d',1.73,2.4,66,'b'),
                event('e',2.4,2.6,64,'b'),event('f',2.6,3,62,'b')]
        rows,_=self.abstract(events)
        self.assertEqual([e['midi'] for e in rows],[66,66,64,62])
        self.assertEqual([e.get('lyric') for e in rows],['甲','乙',None,None])
        self.assertEqual(self.abstract(events,True)[0],events)

    def test_paired_syllable_scoops_need_relative_body_support_not_a_long_note(self):
        events=[event('a',1,1.20,64,'a','甲'),event('b',1.20,1.48,66,'a'),
                event('c',1.48,1.65,64,'b','乙'),event('d',1.65,1.94,66,'b'),
                event('e',1.94,2.2,57,'b')]
        rows,_=self.abstract(events)
        self.assertEqual([e['midi'] for e in rows],[66,66,57])
        self.assertEqual([e.get('lyric') for e in rows],['甲','乙',None])
        self.assertEqual(self.abstract(events,True)[0],events)
        equal=[dict(e) for e in events]
        equal[0]['end']=equal[1]['start']=1.24
        equal[2]['end']=equal[3]['start']=1.71
        self.assertEqual(self.abstract(equal)[0],equal)

    def test_missing_passing_tone_requires_a_stable_connected_contour(self):
        events=[event('a',1,2,66,'a','甲'),event('b',2,3,62,'a')]
        rows,audit=restore_contour_tails(events,pitch_runs=lambda *_:[dict(start=1.85,end=1.99,midi=64,support=.95)])
        self.assertEqual([e['midi'] for e in rows],[66,64,62])
        self.assertEqual(len(audit),1)
        self.assertEqual(restore_contour_tails(events,pitch_runs=lambda *_:[dict(start=1.95,end=1.99,midi=64,support=.95)])[0],events)
        self.assertEqual(restore_contour_tails(events,pitch_runs=lambda *_:[dict(start=1.85,end=1.99,midi=68,support=.95)])[0],events)

    def test_edge_pitch_requires_agreement_and_preserves_clear_chromatic_pitch(self):
        notes=[dict(event('a',1,1.15,60),midiFloat=59.61),
               dict(event('b',2,2.15,60),midiFloat=59.98)]
        rows,audit=resolve_pitch_edges(notes,scale={2,4,6,7,9,11,1},
            contour_pitch=lambda *_: 59.73)
        self.assertEqual([e['midi'] for e in rows],[59,60])
        self.assertEqual(len(audit),1)
        self.assertEqual(resolve_pitch_edges(notes,scale={2,4,6,7,9,11,1},contour_pitch=lambda *_:None)[0],notes)

    def test_written_gate_fills_a_consonant_without_creating_a_rest(self):
        events=[event('a',1.03,1.24,62,'a','甲'),event('b',1.52,1.96,64,'b','乙'),event('c',3,3.8,66,'c','丙')]
        words=[dict(id='a',start=.98,end=1.24),dict(id='b',start=1.25,end=1.97),dict(id='c',start=2.9,end=3.8)]
        notes,_=infer_score_rhythm(events,{'bpm':60,'offsetSeconds':0},words)
        self.assertEqual(notes[0]['duration'],.5)
        self.assertEqual(notes[1]['start'],1.5)
        self.assertLessEqual(notes[1]['start']+notes[1]['duration'],2.25)
        self.assertEqual([n['midi'] for n in notes],[62,64,66])

    def test_plain_written_value_does_not_copy_a_short_articulation_release(self):
        notes,_=infer_score_rhythm([event('a',1,1.79,62)],{'bpm':60,'offsetSeconds':0},[])
        self.assertEqual(notes[0]['duration'],1)

    def test_true_dotted_spacing_and_fast_attacks_remain(self):
        events=[event('a',1,1.74,64),event('b',1.74,1.99,66),event('c',1.99,2.12,67),event('d',2.12,2.25,69)]
        notes,_=infer_score_rhythm(events,{'bpm':60,'offsetSeconds':0},[])
        self.assertEqual(len(notes),4)
        self.assertEqual(notes[0]['duration'],.75)
        self.assertTrue(all(a['start']+a['duration']<=b['start']+1e-8 for a,b in zip(notes,notes[1:])))

    def test_repeated_word_nuclei_can_fit_a_regular_sixteenth_phrase(self):
        rows=[(1.38,1.64),(1.64,1.88),(1.88,2.13),(2.13,2.6)]
        events=[event(str(i),a,b,64,str(i),'字') for i,(a,b) in enumerate(rows)]
        words=[dict(id=str(i),start=a-.04,vowelStart=a,end=b) for i,(a,b) in enumerate(rows)]
        notes,_=infer_score_rhythm(events,dict(bpm=60,offsetSeconds=0),words)
        self.assertEqual([n['start'] for n in notes],[1.25,1.5,1.75,2.])
        self.assertEqual([n['duration'] for n in notes],[.25,.25,.25,.5])
        self.assertEqual([n['id'] for n in notes],[e['id'] for e in events])

    def test_two_unequal_syllables_are_not_regularized_as_a_repeated_run(self):
        events=[event('a',1.06,1.31,62,'a','甲'),event('b',1.31,2.1,62,'b','乙')]
        words=[dict(id=e['id'],start=e['start'],vowelStart=e['start'],end=e['end']) for e in events]
        notes,_=infer_score_rhythm(events,dict(bpm=60,offsetSeconds=0),words)
        self.assertEqual([n['start'] for n in notes],[1.,1.25])
        self.assertEqual(notes[0]['duration'],.25)

    def test_shared_source_repeated_syllables_use_word_onset_and_keep_both_attacks(self):
        events=[dict(event('a',1.0,1.69,73,'a','甲'),sourceIds=['raw']),
                dict(event('b',1.69,2.45,73,'b','乙'),sourceIds=['raw'])]
        words=[dict(id='a',start=.96,vowelStart=1,end=1.59),
               dict(id='b',start=1.59,vowelStart=1.69,end=2.45)]
        notes,_=infer_score_rhythm(events,{'bpm':60,'offsetSeconds':0},words)
        self.assertEqual(len(notes),2)
        self.assertEqual(notes[1]['start'],1.5)
        self.assertEqual([n['lyric'] for n in notes],['甲','乙'])

    def test_long_syncopated_note_is_not_forced_outside_its_acoustic_bound(self):
        notes,_=infer_score_rhythm([event('a',1.25,2.25,64)],{'bpm':60,'offsetSeconds':0},[])
        self.assertEqual(notes[0]['start'],1.25)

    def test_close_attacks_do_not_force_nonbinary_ticks_from_a_ten_ms_grid_miss(self):
        events=[event('a',1.42,1.68,62,'a','甲'),event('b',1.68,1.79,67,'b','乙'),
                event('c',1.79,1.93,69,'b'),event('d',1.93,2.24,67,'c','丙')]
        words=[dict(id='a',start=1.35,vowelStart=1.42,end=1.63),
               dict(id='b',start=1.57,vowelStart=1.68,end=1.9),
               dict(id='c',start=1.76,vowelStart=1.93,end=2.2)]
        notes,_=infer_score_rhythm(events,{'bpm':65,'offsetSeconds':0},words)
        self.assertEqual(len(notes),4)
        self.assertTrue(all(abs(n['duration']*8-round(n['duration']*8))<1e-8 for n in notes))

    def test_continuous_passing_tone_survives_with_readable_rhythm(self):
        events=[event('a',1.6,1.98,66),event('b',1.98,2.03,64),event('c',2.03,2.8,62)]
        rows,audit=mark_legato_transitions(events,seconds_per_beat=1,attack_at=lambda _:False,contour_support=lambda *_:.95)
        notes,_=infer_score_rhythm(rows,{'bpm':60,'offsetSeconds':0},[])
        self.assertEqual([n['midi'] for n in notes],[66,64,62])
        self.assertGreaterEqual(notes[1]['duration'],.25)
        self.assertEqual(len(audit),1)
        self.assertEqual(mark_legato_transitions(events,seconds_per_beat=1,attack_at=lambda _:True,contour_support=lambda *_:.95)[0],events)
        syllables=[events[0],dict(events[1],lyric='甲'),events[2]]
        self.assertEqual(mark_legato_transitions(syllables,seconds_per_beat=1,attack_at=lambda _:False,contour_support=lambda *_:.95)[0],syllables)

    def unworded(self, events, attack=False, spread=.7):
        return abstract_unworded_approaches(events, seconds_per_beat=1,
            attack_at=lambda _: attack, structural_attack=lambda _: attack,
            pitch_support=lambda *_: .95, onset_pitch_spread=lambda *_: spread)

    def test_audio_only_scoop_uses_destination_without_losing_its_attack_time(self):
        events=[event('a',1,1.16,62),event('b',1.16,1.8,64),event('c',2,2.5,66)]
        rows,audit=self.unworded(events)
        self.assertEqual([(e['midi'],e['start'],e['end']) for e in rows],[(64,1,1.8),(66,2,2.5)])
        self.assertEqual(audit[0]['sourceIds'],['a','b'])
        self.assertEqual(self.unworded(events,attack=True)[0],events)

    def test_audio_only_runs_and_stable_short_notes_remain(self):
        run=[event('x',.84,1,61),event('a',1,1.16,62),event('b',1.16,1.42,64),event('c',1.42,1.6,62)]
        self.assertEqual(self.unworded(run)[0],run)
        stable=[event('a',1,1.2,62),event('b',1.2,1.42,64)]
        self.assertEqual(self.unworded(stable,spread=.2)[0],stable)

    def test_chunk_seam_overlap_keeps_both_attacks_monophonic(self):
        events=[event('a',1,2.04,67),event('b',2.01,3,67)]
        rows,audit=resolve_chunk_seams(events)
        self.assertEqual([(e['id'],e['start'],e['end']) for e in rows],[('a',1,2.01),('b',2.01,3)])
        self.assertEqual(audit[0]['action'],'resolve-chunk-seam-overlap')
        with self.assertRaises(ValueError):
            resolve_chunk_seams([event('a',1,2,67),event('b',1,2,69)])

    def test_vocal_phase_requires_consistent_positive_evidence(self):
        grid={'bpm':60,'offsetSeconds':0}
        delayed=[event(str(i),i*.25+.06,i*.25+.2,60) for i in range(40)]
        phase,audit=estimate_vocal_phase(delayed,grid)
        self.assertEqual(phase,.06)
        self.assertTrue(audit['applied'])
        aligned=[event(str(i),i*.25,i*.25+.2,60) for i in range(40)]
        self.assertEqual(estimate_vocal_phase(aligned,grid)[0],0.)
        early=[event(str(i),i*.25-.02,i*.25+.2,60) for i in range(1,41)]
        self.assertEqual(estimate_vocal_phase(early,grid)[0],0.)


if __name__=='__main__':unittest.main()
