/** Whether the credential read now is the hash that was checked; a missing hash or a failed read answers no. */
export const credentialIsStill = async (read: () => Promise<string | undefined>, checked: string | undefined): Promise<boolean> => {
  try {
    return checked !== undefined && await read() === checked;
  } catch {
    return false;
  }
};
