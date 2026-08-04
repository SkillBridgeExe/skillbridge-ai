import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, JwtUser } from '../auth/decorators/current-user.decorator';
import { CvAnalysisOrchestrationService } from './cv-analysis-orchestration.service';
import { CvAnalysisRequestDto } from './dto/cv-analysis-request.dto';

const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;

@ApiTags('Diagnosis')
@ApiBearerAuth()
@Public()
@UseGuards(AuthGuard('jwt'))
@Controller('api/diagnosis')
export class CvAnalysisController {
  constructor(private readonly orchestration: CvAnalysisOrchestrationService) {}

  @Post('cv-analysis')
  @ApiOperation({ summary: 'Upload or rescan one CV, optionally with a JD, for one shared usage' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['targetRole', 'consentAccepted'],
      properties: {
        file: { type: 'string', format: 'binary' },
        cvId: { type: 'string', format: 'uuid' },
        targetRole: { type: 'string' },
        consentAccepted: { type: 'boolean' },
        jdText: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_CV_FILE_BYTES },
    }),
  )
  async analyze(
    @CurrentUser() user: JwtUser,
    @Body() dto: CvAnalysisRequestDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if ((file ? 1 : 0) + (dto.cvId ? 1 : 0) !== 1) {
      throw new BadRequestException({
        errorCode: ERROR_CODES.VALIDATION_ERROR,
        message: 'Provide exactly one of file or cvId',
      });
    }

    return this.orchestration.analyze(user.userId, dto, file);
  }
}
