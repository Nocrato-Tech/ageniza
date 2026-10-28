import type { EmailService } from '../../auth/email-service.js';

/** An e-mail service for the tests of routes that never send mail: any call is a failure of the test. */
export const unusedEmailService: EmailService = {
  sendPasswordReset: () => { throw new Error('This test sends no e-mail.'); },
  sendEmailChangeRequested: () => { throw new Error('This test sends no e-mail.'); },
  sendEmailChanged: () => { throw new Error('This test sends no e-mail.'); },
  sendEmailVerification: () => { throw new Error('This test sends no e-mail.'); },
  sendSignUpWithExistingAccount: () => { throw new Error('This test sends no e-mail.'); },
  sendCollaboratorInvitation: () => Promise.reject(new Error('This test sends no e-mail.')),
  sendClientInvitation: () => Promise.reject(new Error('This test sends no e-mail.')),
  sendClientPortalWelcome: () => Promise.reject(new Error('This test sends no e-mail.')),
  drain: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
};
