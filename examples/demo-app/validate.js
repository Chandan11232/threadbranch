// Deliberately thin, so the demo has real work to hand the agent:
// no email validation, no password rules.
export function validateSignup({ name = '', email = '', password = '' }) {
  const errors = [];
  if (!name.trim()) errors.push('Name is required');
  if (!email.trim()) errors.push('Email is required');
  if (!password) errors.push('Password is required');
  return errors;
}
