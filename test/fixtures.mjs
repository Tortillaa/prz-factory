// A card body that passes lint.
export const GOOD_BODY = `## Problem
Users cannot sign in with their email address.

## Context
- **Where:** /login
- **Who:** every visitor

## Fix
Add an email + password form that calls the existing auth API.

## Acceptance Criteria
- [ ] Submitting a valid email and password redirects to /home
- [ ] A wrong password shows "Credenciales incorrectas" under the form

## Risk
🟢 **Low** · new form, no change to existing flows
`;
