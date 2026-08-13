import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { params, query, validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { orderNumberParamsSchema } from '../checkout/checkout.schemas.js';
import * as ordersService from './orders.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

const list: RequestHandler = async (req, res) => {
  const { page, pageSize } = query(req, listQuerySchema);
  res.json(await ordersService.listForUser(req.user!.id, { page, pageSize }));
};

const getOne: RequestHandler = async (req, res) => {
  const { orderNumber } = params(req, orderNumberParamsSchema);
  res.json(await ordersService.getForUser(orderNumber, req.user!));
};

export const ordersRouter = Router();

ordersRouter.use(requireAuth);
ordersRouter.get('/', validate({ query: listQuerySchema }), list);
ordersRouter.get('/:orderNumber', validate({ params: orderNumberParamsSchema }), getOne);
