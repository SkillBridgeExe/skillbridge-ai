import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';

describe('AuthController', () => {
  it('refreshes the access token, rotates the refresh cookie, and returns the user', async () => {
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User Example',
      roles: ['USER'],
      isEmailVerified: true,
    };
    const auth = {
      refresh: jest.fn().mockResolvedValue({
        user,
        accessToken: 'access-token',
        expiresIn: 3600,
        refreshToken: 'rotated-refresh-token',
      }),
    } as unknown as AuthService;
    const config = {
      get: jest.fn().mockReturnValue(604800),
    } as unknown as ConfigService;
    const controller = new AuthController(auth, config);
    const req = { cookies: { skillbridge_refresh_token: 'refresh-token' } };
    const res = { cookie: jest.fn() };

    await expect(controller.refresh(req as never, res as never)).resolves.toEqual({
      user,
      accessToken: 'access-token',
      expiresIn: 3600,
    });

    expect(auth.refresh).toHaveBeenCalledWith('refresh-token');
    expect(res.cookie).toHaveBeenCalledWith(
      'skillbridge_refresh_token',
      'rotated-refresh-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 604800000,
      }),
    );
  });

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
