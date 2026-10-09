import express from 'express';
import pool from './db.js';

const router = express.Router();

// Safe inventory deduction route with row-locking, transactions, and real-time broadcast
router.post('/deduct', async (req, res) => {
  const { itemId, warehouseId, quantity, userId } = req.body;
  
  const connection = await pool.getConnection();
  
  try {
    // 1. Start transaction
    await connection.beginTransaction();

    // 2. Select and lock the specific inventory row
    const [rows] = await connection.execute(
      'SELECT quantity FROM inventory WHERE item_id = ? AND warehouse_id = ? FOR UPDATE',
      [itemId, warehouseId]
    );

    if (rows.length === 0) {
      throw new Error('Inventory record not found for this warehouse.');
    }

    const currentStock = rows[0].quantity;

    // 3. Validate stock availability
    if (currentStock < quantity) {
      throw new Error(`Insufficient stock. Available: ${currentStock}, Requested: ${quantity}`);
    }

    const newStock = currentStock - quantity;

    // 4. Update inventory
    await connection.execute(
      'UPDATE inventory SET quantity = ? WHERE item_id = ? AND warehouse_id = ?',
      [newStock, itemId, warehouseId]
    );

    // 5. Log transaction
    await connection.execute(
      `INSERT INTO inventory_transactions 
       (item_id, warehouse_id, quantity_change, user_id, transaction_type, created_at) 
       VALUES (?, ?, ?, ?, 'DEDUCTION', NOW())`,
      [itemId, warehouseId, -quantity, userId]
    );

    // 6. Commit changes
    await connection.commit();
    
    // 7. Broadcast real-time update to all connected clients
    if (req.io) {
      req.io.emit('stockUpdated', { itemId, warehouseId, newStock });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Stock successfully updated.', 
      newStock 
    });

  } catch (error) {
    // Rollback changes on failure
    await connection.rollback();
    return res.status(400).json({ 
      success: false, 
      error: error.message 
    });

  } finally {
    connection.release();
  }
});

export default router;