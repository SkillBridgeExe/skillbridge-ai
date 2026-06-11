import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';

describe('AuthController', () => {
  it('clears the refresh cookie with the same options used when setting it', async () => {
    const auth = {
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthService;
    const config = {
      get: jest.fn().mockReturnValue(604800),
    } as unknown as ConfigService;
    const controller = new AuthController(auth, config);
    const req = { cookies: { skillbridge_refresh_token: 'refresh-token' } };
    const res = { clearCookie: jest.fn() };

    await controller.logout(req as never, res as never);

    expect(auth.logout).toHaveBeenCalledWith('refresh-token');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'skillbridge_refresh_token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      }),
    );
  });
});
