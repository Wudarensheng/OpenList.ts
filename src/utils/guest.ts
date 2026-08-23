/**
 * Guest user helper.
 *
 * The frontend's user model is: role 0 = general user, role 1 = guest, role 2 = admin.
 * The guest user has NO permissions (permission = 0), so it can only browse
 * file listings and download files — every privileged action (write, rename,
 * move, copy, delete, upload, offline download, share, ...) requires a
 * permission bit it does not have.
 */
export function getGuestUser(): Record<string, any> {
  return {
    id: 2,
    username: 'guest',
    role: 1,
    disabled: false,
    permission: 0,
    sso_id: '',
    otp: false,
    password: '',
    base_path: '/',
    home_dir: '/',
    allow_ldap: false,
  };
}
