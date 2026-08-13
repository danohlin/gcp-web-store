import { Router, type RequestHandler } from 'express';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import * as adminService from './admin.service.js';
import {
  adminOrderQuerySchema,
  adminProductQuerySchema,
  createCategorySchema,
  createProductSchema,
  idParamsSchema,
  updateCategorySchema,
  updateOrderStatusSchema,
  updateProductSchema,
} from './admin.schemas.js';

const listProducts: RequestHandler = async (req, res) => {
  res.json(await adminService.listProducts(query(req, adminProductQuerySchema)));
};

const getProduct: RequestHandler = async (req, res) => {
  res.json(await adminService.getProduct(params(req, idParamsSchema).id));
};

const createProduct: RequestHandler = async (req, res) => {
  res.status(201).json(await adminService.createProduct(body(req, createProductSchema)));
};

const updateProduct: RequestHandler = async (req, res) => {
  const { id } = params(req, idParamsSchema);
  res.json(await adminService.updateProduct(id, body(req, updateProductSchema)));
};

const deleteProduct: RequestHandler = async (req, res) => {
  const { id } = params(req, idParamsSchema);
  res.json(await adminService.deleteProduct(id));
};

const createCategory: RequestHandler = async (req, res) => {
  res.status(201).json(await adminService.createCategory(body(req, createCategorySchema)));
};

const updateCategory: RequestHandler = async (req, res) => {
  const { id } = params(req, idParamsSchema);
  res.json(await adminService.updateCategory(id, body(req, updateCategorySchema)));
};

const deleteCategory: RequestHandler = async (req, res) => {
  const { id } = params(req, idParamsSchema);
  res.json(await adminService.deleteCategory(id));
};

const listOrders: RequestHandler = async (req, res) => {
  res.json(await adminService.listOrders(query(req, adminOrderQuerySchema)));
};

const updateOrderStatus: RequestHandler = async (req, res) => {
  const { id } = params(req, idParamsSchema);
  const { status } = body(req, updateOrderStatusSchema);
  res.json(await adminService.updateOrderStatus(id, status));
};

export const adminRouter = Router();

// Every route below requires a valid token belonging to an ADMIN user.
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/products', validate({ query: adminProductQuerySchema }), listProducts);
adminRouter.post('/products', validate({ body: createProductSchema }), createProduct);
adminRouter.get('/products/:id', validate({ params: idParamsSchema }), getProduct);
adminRouter.patch(
  '/products/:id',
  validate({ params: idParamsSchema, body: updateProductSchema }),
  updateProduct,
);
adminRouter.delete('/products/:id', validate({ params: idParamsSchema }), deleteProduct);

adminRouter.post('/categories', validate({ body: createCategorySchema }), createCategory);
adminRouter.patch(
  '/categories/:id',
  validate({ params: idParamsSchema, body: updateCategorySchema }),
  updateCategory,
);
adminRouter.delete('/categories/:id', validate({ params: idParamsSchema }), deleteCategory);

adminRouter.get('/orders', validate({ query: adminOrderQuerySchema }), listOrders);
adminRouter.patch(
  '/orders/:id/status',
  validate({ params: idParamsSchema, body: updateOrderStatusSchema }),
  updateOrderStatus,
);
