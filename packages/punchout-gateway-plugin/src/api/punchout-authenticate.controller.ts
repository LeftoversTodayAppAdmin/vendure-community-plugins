import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { Response } from 'express';

import { loggerCtx, PUNCHOUT_GATEWAY_PLUGIN_OPTIONS } from '../constants';
import { PunchOutGatewayPluginOptions } from '../types';

@Controller('punchcommerce')
export class PunchOutAuthenticateController {
    constructor(
        @Inject(PUNCHOUT_GATEWAY_PLUGIN_OPTIONS) private options: PunchOutGatewayPluginOptions,
    ) {}

    @Get('authenticate')
    authenticate(
        @Query('sID') sID: string,
        @Query('uID') uID: string,
        @Res() res: Response,
    ) {
        if (!sID || !uID) {
            Logger.warn('PunchOut authenticate called without sID or uID', loggerCtx);
            res.status(400).json({ error: 'Missing sID or uID parameter' });
            return;
        }

        Logger.verbose(
            `PunchOut authenticate redirect received for sID=${sID.substring(0, 8)}...`,
            loggerCtx,
        );

        const redirectUrl = this.options.storefrontUrl;
        if (redirectUrl) {
            const url = new URL(redirectUrl);
            url.searchParams.set('sID', sID);
            url.searchParams.set('uID', uID);
            res.redirect(url.toString());
        } else {
            // No storefront URL configured — return JSON for API-level testing
            res.json({ sID, uID });
        }
    }
}
