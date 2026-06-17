## §F — State reversibility and permissions (IDA/VOLTA)

This rule is a reminder integrated into §B (planning), not a blocker.

**When it applies:**
Any operation that changes persistent state: create, save, group, approve,
publish, activate, link, generate (e.g., generate a quote from grouped items).

**Two mandatory questions in every plan:**

1. **Permissions**: will the user have permission to execute this operation?
   - Check existing RBAC/ACL/roles in the codebase.
   - If permission rules are not found or documented: ask the developer
     before including in the plan.
   - Apply the same question to the reverse operation:
     who can undo? Same role? Different role?

2. **Reversibility**: is a reverse operation needed?
   - If yes: define what "reverse" means in this specific domain.
     Example: "cancel quote" is not just deleting a record — it must
     restore grouped items to their previous state.
   - If yes and not yet planned: suggest including the reverse flow
     as part of the current plan or as a follow-up task.
   - If no: record explicitly "no reverse operation needed" in the plan.

**If the developer accepts implementing the reverse flow:**
- Follow §B (plan with 2+ options + reuse analysis).
- Follow §C (updated OK for commit/push).
- Evaluate permissions for the reverse operation as well.

**If the developer does not accept:**
- Proceed normally without recording a pending item.
