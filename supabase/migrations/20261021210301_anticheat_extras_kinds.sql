-- Anti-cheat extras (#63; ANT-03, ANT-05, ANT-06, ANT-07): the new kinds of "needs
-- review" flag. On their own so they are committed before 20261021210304 uses them (a
-- new enum value can't be used in the transaction that adds it).
--
--   synthetic_click  ANT-03 (macOS): clicks on the card that looked synthetic; let
--                    through, so the check-in's outcome is its own.
--   virtual_camera   ANT-05: the webcam frame came from a known virtual camera.
--   duplicate_frame  ANT-06: the webcam frame is near-identical to an earlier passed
--                    check-in's on the same device (compared there, by hash).
--   virtual_machine  ANT-07: the agent ran inside a virtual machine.
--   remote_session   ANT-07: the session was a remote one or remotely controlled.

alter type public.anticheat_kind add value if not exists 'synthetic_click';
alter type public.anticheat_kind add value if not exists 'virtual_camera';
alter type public.anticheat_kind add value if not exists 'duplicate_frame';
alter type public.anticheat_kind add value if not exists 'virtual_machine';
alter type public.anticheat_kind add value if not exists 'remote_session';
