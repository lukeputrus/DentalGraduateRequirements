// Demo mode (DEMO_MODE=true) seeds shared demo accounts with published
// passwords so anyone with the link can try the app. Those accounts are
// locked against password changes and deletion so one visitor can't lock
// the others out.
const DEMO_PASSWORD = 'demo1234';

const DEMO_ACCOUNTS = [
  { username: 'demo-admin', role: 'admin', label: 'Admin view' },
  { username: 'demo-student', role: 'student', label: 'Student (Detroit Mercy, Class of 2028)' },
  { username: 'demo-nyu', role: 'student', label: 'Student (NYU procedure counts, Class of 2027)' },
];

function isDemoMode() {
  return process.env.DEMO_MODE === 'true';
}

function isDemoAccount(user) {
  return isDemoMode() && !!user && DEMO_ACCOUNTS.some((a) => a.username === user.username);
}

module.exports = { DEMO_PASSWORD, DEMO_ACCOUNTS, isDemoMode, isDemoAccount };
