import z from 'zod';
import { db } from '#db/index'
import { $ } from '#utils/factory'
import { HttpError } from '#utils/http';

export const loadToken = $.createMiddleware(async (c, next) => {
	const authorizationHeader = c.req.header('Authorization')

	const isCommonProblemWithEnv = authorizationHeader?.includes('NPM_TOKEN')
	let errorText = ''
	if (isCommonProblemWithEnv) {
		errorText = 'NPM token wasn\'t resolved in .npmrc'
		throw HttpError.unauthorized(errorText)
	}

	// TODO Add auth header regex validation
	const bearer = authorizationHeader?.trim().split(' ')?.[1]
	if (!bearer) {
		errorText = 'Malformed Authorization header'
		throw HttpError.unauthorized(errorText)
	}

	const targetedToken = await db.query.tokenTable.findFirst({
		where: (table, { eq }) => eq(table.token, bearer)
	});

	if (!targetedToken) throw HttpError.forbidden(('Auth token is invalid'))
	c.set("token", targetedToken);

	await next();
});