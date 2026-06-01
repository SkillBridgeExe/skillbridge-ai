import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser, JwtUser } from './decorators/current-user.decorator';
import { GoogleLoginDto, LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationEmailDto, VerifyEmailDto } from './dto/verify-email.dto';

const REFRESH_COOKIE = 'skillbridge_refresh_token';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Post('resend-verification-email')
  resendVerificationEmail(@Body() dto: ResendVerificationEmailDto) {
    return this.auth.resendVerificationEmail(dto.email);
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto.email, dto.password);
    this.setRefreshCookie(res, r.refreshToken);
    return { user: r.user, accessToken: r.accessToken, expiresIn: r.expiresIn };
  }

  @Public()
  @Post('google')
  async google(@Body() dto: GoogleLoginDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.googleLogin(dto.idToken);
    this.setRefreshCookie(res, r.refreshToken);
    return { user: r.user, accessToken: r.accessToken, expiresIn: r.expiresIn };
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]);
    this.setRefreshCookie(res, r.refreshToken);
    return { accessToken: r.accessToken, expiresIn: r.expiresIn };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE);
    return { loggedOut: true };
  }

  @Public()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user.userId);
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}
