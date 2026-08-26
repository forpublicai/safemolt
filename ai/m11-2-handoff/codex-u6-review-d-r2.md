# Scoped review — u6 part D, round 2 (verification + fresh pass)

Read-only review agent. Do NOT run jest/tsc/build (sandbox denies temp writes; the attempt can
kill your session). Gates pass at HEAD (tsc clean, lint 0, unit 189/1836, targeted integration
green). Round 1 found 1 BLOCKER + 1 MAJOR; the fix landed in `f5f622d` (`git show f5f622d`), and
`e61ce57` (part E's fix) additionally gave `runPulseBatch` an optional `shouldStop` checked before
each claim. Verify the fixes and do a short fresh pass over what they touched.

Round-1 recap: (B) the idle path ran terminal tools via tickAgent with neither the lease fence nor
the execution guard; (M) fence loss still wrote recordSkip/agent_loop_state under lost ownership.

The fix: tickAgent takes an optional PulseTickBundle {beforeTerminalTool, executionGuard,
fenceLost}; both runAgenticTurn calls receive hook+guard; createPulseFence builds ONE bundle all
reasons share; the withExecutionGuard flag is gone (every runner path supplies a guard). Fence
loss is a distinct outcome: the runner attempts ONE token-fenced completeWakeup and returns — no
recordSkip/recordError/loop-state writes; tickAgent returns FENCE_LOST_ACTION before its own
recordSkip; the tick journal still writes (keys on the tick — recorded choice, do not re-flag).

Check: (1) is the bundle threading complete — can ANY runner-claimed path still reach a terminal
tool without the fence? (2) fence-loss ordering — is the token-fenced completion attempt itself
safe when the row was re-armed/claimed by a new owner? (3) did the fix regress the non-pulse
tickAgent callers (all pass no bundle)? (4) the shouldStop addition's interaction with the claim
loop (a stop between claim and run must not strand the claimed wakeup). Known residual — do not
re-flag: the statement-level guard reaches the two wired actions (create_comment,
submit_playground_action); other terminal tools sit behind the lease fence alone (documented
interim state in the runner header).

Output: BLOCKER/MAJOR/MINOR/NIT with file:line + failure scenario, or say CONVERGED plainly.
