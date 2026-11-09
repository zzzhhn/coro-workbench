import unittest
from server.vocal_notation import infer_vocal_notation


class VocalNotationTests(unittest.TestCase):
    def test_repeated_attacks_fast_notes_and_real_breath_survive(self):
        events = [{'start': a, 'end': b, 'midi': p} for a, b, p in
                  [(0, .5, 60), (.5, .625, 60), (.625, .75, 62), (1.1, 1.5, 64)]]
        notes, audit = infer_vocal_notation(events, {'bpm': 60, 'offsetSeconds': 0}, 2)
        self.assertEqual([n['midi'] for n in notes], [60, 60, 62, 64])
        self.assertEqual(notes[0]['start'] + notes[0]['duration'], notes[1]['start'])
        self.assertEqual(notes[1]['start'] + notes[1]['duration'], notes[2]['start'])
        self.assertGreaterEqual(notes[3]['start'] - notes[2]['start'] - notes[2]['duration'], .23)
        self.assertEqual(audit['changes'][1]['sourceEndSeconds'], .625)

    def test_negative_origin_is_supported_without_changing_input(self):
        events = [{'start': .1, 'end': .55, 'midi': 62}]
        notes, audit = infer_vocal_notation(events, {'bpm': 65, 'offsetSeconds': -2.7}, 1)
        self.assertEqual(events, [{'start': .1, 'end': .55, 'midi': 62}])
        self.assertLessEqual(abs(audit['changes'][0]['scoreStartSeconds'] - .1), .16)
        self.assertGreater(notes[0]['start'], 0)

    def test_overlap_is_not_silently_repaired(self):
        with self.assertRaises(ValueError):
            infer_vocal_notation([{'start': 0, 'end': 1, 'midi': 60},
                                  {'start': .9, 'end': 2, 'midi': 64}],
                                 {'bpm': 60, 'offsetSeconds': 0}, 3)


if __name__ == '__main__':
    unittest.main()
