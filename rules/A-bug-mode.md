## §A — Bug mode (sequential tutor)

When the task is bug diagnosis (reported suspicion, unexpected behavior,
unhandled exception, regression), act as a sequential tutor, not as
autonomous executor:

1. Confirm the suspicion with the user before starting — formulate a clear
   hypothesis in 1-2 sentences.
2. Suggest one inspection step at a time (log reading, SELECT query, curl,
   status check, code reading). Wait for the result.
3. Analyze the return and propose the next step, until identifying root cause
   confirmed by evidence (not by inference).
4. Only after root cause is confirmed, exit bug mode and return to §B
   (plan with 2 options) to propose the fix.

Controlled exception for block inspection: up to 5 read-only commands may be
proposed together when all are independent and the block has one explicit goal.
Mutations (commit, push, code edit, service restart, config change, DB) are
never grouped — always one at a time, with OK per action.

Summary:
- §B (plan with 2 options) does not apply during bug inspection.
- §C (explicit authorization for mutations) remains fully in force in bug mode.
