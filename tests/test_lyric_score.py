import unittest
import copy

from server.lyric_score import interpret, notate


def event(name, start, end, midi=64):
    return dict(id=name, start=start, end=end, midi=midi)


def word(name, start, end, text='音'):
    return dict(id=name, start=start, vowelStart=start, end=end, text=text)


class LyricInterpretationTests(unittest.TestCase):
    def test_two_syllables_rearticulate_one_pitch_without_changing_coverage(self):
        original = [event('e', 1, 2)]
        rows, audit = interpret(original, [word('w1', 1, 1.5, '声'), word('w2', 1.5, 2)])
        self.assertEqual([(r['midi'], r['start'], r['end'], r['lyric']) for r in rows],
                         [(64, 1, 1.5, '声'), (64, 1.5, 2, '音')])
        self.assertEqual(original, [event('e', 1, 2)])
        self.assertTrue(all(r['sourceIds'] == ['e'] for r in rows))
        self.assertFalse(audit['referenceNotesUsed'])

    def test_melisma_preserves_all_pitch_changes_with_one_lyric(self):
        rows, _ = interpret([event('a', 1, 1.4), event('b', 1.4, 1.7, 66),
                             event('c', 1.7, 2)], [word('w', 1, 2)])
        self.assertEqual([r['midi'] for r in rows], [64, 66, 64])
        self.assertEqual([r.get('lyric') for r in rows], ['音', None, None])

    def test_same_word_merge_requires_no_new_acoustic_attack(self):
        events = [event('a', 1, 1.1), event('b', 1.1, 2)]
        words = [word('w', 1, 2)]
        self.assertEqual(len(interpret(events, words)[0]), 2)
        self.assertEqual(len(interpret(events, words, lambda _: True)[0]), 2)
        rows, _ = interpret(events, words, lambda _: False)
        self.assertEqual([(r['start'], r['end'], r['sourceIds']) for r in rows], [(1, 2, ['a', 'b'])])

    def test_distinct_words_cannot_be_merged_even_without_energy_attack(self):
        rows, _ = interpret([event('a', 1, 1.1), event('b', 1.1, 2)],
                            [word('a', 1, 1.1), word('b', 1.1, 2)], lambda _: False)
        self.assertEqual(len(rows), 2)

    def test_short_alignment_and_silence_cannot_invent_notes(self):
        original = [event('a', 1, 2), event('b', 3, 4)]
        rows, audit = interpret(original, [word('tiny', 1.2, 1.21), word('gap', 2.4, 2.7)])
        self.assertEqual([(r['start'], r['end']) for r in rows], [(1, 2), (3, 4)])
        self.assertEqual([d['action'] for d in audit['decisions']],
                         ['uncertain-short-alignment', 'no-supported-pitched-interval'])

    def test_notation_preserves_pitch_count_shared_edges_and_real_rests(self):
        events = [event('a', 1.03, 1.14), event('b', 1.14, 1.8, 66), event('c', 2.4, 2.9)]
        notes, audit = notate(events, {'bpm': 65, 'offsetSeconds': 0}, 3)
        self.assertEqual([n['midi'] for n in notes], [64, 66, 64])
        self.assertAlmostEqual(audit[0]['scoreEndSeconds'], audit[1]['scoreStartSeconds'])
        self.assertGreaterEqual(audit[2]['scoreStartSeconds'] - audit[1]['scoreEndSeconds'], .5 - 1e-6)
        for source, output in zip(events, audit):
            length = source['end'] - source['start']
            written = output['scoreEndSeconds'] - output['scoreStartSeconds']
            self.assertLessEqual(abs(written / length - 1), .45 + 1e-6)
            self.assertLessEqual(abs(output['scoreStartSeconds'] - source['start']), .115 + 1e-6)


class ReadableSingingTests(unittest.TestCase):
    def test_short_onset_scoop_becomes_stable_body_but_next_syllable_repeats(self):
        from server.lyric_score import abstract_onset_scoops
        events = [dict(event('a', 1, 1.17, 62), wordId='w', lyric='甲', sourceIds=['a']),
                  dict(event('b', 1.17, 1.5, 64), wordId='w', sourceIds=['b']),
                  dict(event('c', 1.5, 2, 64), wordId='next', lyric='乙', sourceIds=['c'])]
        original = copy.deepcopy(events)
        rows, audit = abstract_onset_scoops(events, seconds_per_beat=.92,
                                          attack_at=lambda _: False, pitch_support=lambda *_: .95,
                                          onset_pitch_spread=lambda *_: .8)
        self.assertEqual([(r['midi'], r['start'], r['end']) for r in rows], [(64, 1, 1.5), (64, 1.5, 2)])
        self.assertEqual(rows[0]['sourceIds'], ['a', 'b'])
        self.assertEqual(events, original)
        self.assertEqual(len(audit), 1)

    def test_real_attacks_long_first_notes_and_multi_note_melismas_survive(self):
        from server.lyric_score import abstract_onset_scoops
        def check(events, attack=False, support=.95, spread=.8):
            rows, audit = abstract_onset_scoops(events, seconds_per_beat=.92,
                attack_at=lambda _: attack, pitch_support=lambda *_: support,
                onset_pitch_spread=lambda *_: spread)
            self.assertEqual(rows, events)
            self.assertEqual(audit, [])
        base = [dict(event('a', 1, 1.17, 62), wordId='w', lyric='甲', sourceIds=['a']),
                dict(event('b', 1.17, 1.5, 64), wordId='w', sourceIds=['b'])]
        check(base, attack=True)
        check(base, support=.4)
        # A genuine short melisma may be legato: an energy attack is not
        # required when the first pitch has a stable acoustic plateau.
        check(base, spread=.39)
        check(base, spread=None)
        check([dict(base[0], end=1.35), dict(base[1], start=1.35, end=1.8)])
        check(base + [dict(event('c', 1.5, 1.8, 62), wordId='w', sourceIds=['c'])])
        check([base[0], dict(base[1], wordId='other', lyric='乙')])

    def test_collapsed_shared_nucleus_recovers_inside_supported_event(self):
        from server.lyric_score import infer_shared_vowel_words
        words = [dict(word('a', 1, 1.9, '甲'), phones=[{'phone':'d'}, {'phone':'a'}]),
                 dict(word('b', 1.9, 1.906, '乙'), phones=[{'phone':'an'}]),
                 dict(word('c', 1.92, 2.3, '丙'), phones=[{'phone':'h'}, {'phone':'ai'}])]
        events = [event('a',1,1.18,62), event('b',1.18,1.92,64),event('c',1.92,2.3,66)]
        repaired, audit = infer_shared_vowel_words(events, words, {'bpm':60,'offsetSeconds':0},
            nucleus_support=lambda *_: {'familyMean':.22,'relativeNasal':1.6})
        self.assertAlmostEqual(repaired[1]['vowelStart'],1.25)
        self.assertEqual(repaired[1]['boundarySource'],'shared-vowel-inference')
        self.assertLess(repaired[1]['vowelStart'],repaired[2]['vowelStart'])
        self.assertEqual(words[1]['vowelStart'],1.9)
        self.assertEqual(len(audit),1)

    def test_shared_vowel_repair_abstains_without_unique_supported_interval(self):
        from server.lyric_score import infer_shared_vowel_words
        words = [dict(word('a',1,1.9),phones=[{'phone':'a'}]),
                 dict(word('b',1.9,1.906),phones=[{'phone':'an'}]),
                 dict(word('c',1.92,2.3),phones=[{'phone':'h'},{'phone':'ai'}])]
        for events, support in [([event('a',1,1.92)], {'familyMean':.22,'relativeNasal':1.6}),
                                ([event('a',1,1.18),event('b',1.18,1.92)], {'familyMean':.02,'relativeNasal':.4}),
                                ([event('a',1,1.18),event('b',1.18,1.4),event('c',1.6,1.92)], {'familyMean':.22,'relativeNasal':1.6})]:
            repaired, audit = infer_shared_vowel_words(events, words, {'bpm':60,'offsetSeconds':0},
                nucleus_support=lambda *_: support)
            self.assertEqual(repaired,words)
            self.assertEqual(audit,[])


if __name__ == '__main__':
    unittest.main()
