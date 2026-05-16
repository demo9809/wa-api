'use strict';

/**
 * Message templates for illoo store WhatsApp notifications.
 * All templates use {{variable}} placeholders.
 */
const TEMPLATES = {
  order_placed_online: {
    name: 'Order Placed (Online Payment)',
    template: (vars) =>
      `✅ *Payment Confirmed!*\n\nHi {{parent_name}}, thank you for your order on illoo! 🎉\n\n📦 *Order Details:*\n• Order ID: #{{order_id}}\n• Product: {{product_name}}\n• Amount Paid: ₹{{amount}}\n\n👦 *Child Details:*\n• Name: {{child_name}}\n• School: {{school_name}}\n• Class: {{class_name}}\n\n🚚 *Shipping Address:*\n{{address}}\n\n⏱ Expected dispatch in *{{dispatch_days}} working days*.\n\n🔍 Track your order: {{tracking_url}}\n\nFor any queries, reply to this message. Happy shopping! 😊`,
  },

  order_placed_cod: {
    name: 'Order Placed (Cash on Delivery)',
    template: (vars) =>
      `🛍️ *Order Confirmed!*\n\nHi {{parent_name}}, your order has been placed successfully on illoo!\n\n📦 *Order Details:*\n• Order ID: #{{order_id}}\n• Product: {{product_name}}\n• Amount to Pay: ₹{{amount}} (Cash on Delivery)\n\n👦 *Child Details:*\n• Name: {{child_name}}\n• School: {{school_name}}\n• Class: {{class_name}}\n\n🚚 *Shipping Address:*\n{{address}}\n\n⏱ Expected dispatch in *{{dispatch_days}} working days*.\n\nPlease keep ₹{{amount}} ready at the time of delivery. 💰\n\nFor any queries, reply to this message. Happy shopping! 😊`,
  },

  order_processing: {
    name: 'Order Processing',
    template: (vars) =>
      `⚙️ *Order Update — Processing*\n\nHi {{parent_name}}! Your order *#{{order_id}}* is now being processed.\n\nOur team is carefully preparing the personalised product for *{{child_name}}*. We'll notify you once it's packed and ready to ship! 📦\n\nFor queries, just reply here. Thank you for choosing illoo! 🌟`,
  },

  order_packed: {
    name: 'Order Packed',
    template: (vars) =>
      `📦 *Order Packed & Ready to Ship!*\n\nHi {{parent_name}}! Great news — your order *#{{order_id}}* has been packed and is ready to be handed over to our shipping partner.\n\nWe're shipping the personalised product for *{{child_name}}* very soon! You'll receive a tracking number once it's dispatched. 🚀\n\nFor queries, just reply here. Thank you for your patience! 😊`,
  },

  order_shipped: {
    name: 'Order Shipped',
    template: (vars) =>
      `🚚 *Your Order Has Been Shipped!*\n\nHi {{parent_name}}! Your order *#{{order_id}}* is on its way to you!\n\n📬 *Tracking Details:*\n• Tracking Number: {{tracking_number}}\n• Carrier: India Post\n• Track here: https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx\n\nEnter your tracking number *{{tracking_number}}* on the above link to get real-time updates.\n\nExpected delivery in 3–7 working days. We're excited for *{{child_name}}* to receive their personalised product! 🎉`,
  },

  order_delivered: {
    name: 'Order Delivered',
    template: (vars) =>
      `🎉 *Order Delivered!*\n\nHi {{parent_name}}! Your order *#{{order_id}}* has been delivered.\n\nWe hope *{{child_name}}* absolutely loves their new personalised product from illoo! 💖\n\nWe'd love to hear your feedback — a quick review means the world to us and helps other parents discover illoo:\n👉 {{tracking_url}}\n\nThank you for shopping with illoo. We can't wait to serve you again! 🌟`,
  },

  order_cancelled: {
    name: 'Order Cancelled',
    template: (vars) =>
      `❌ *Order Cancelled*\n\nHi {{parent_name}}, your order *#{{order_id}}* has been cancelled.{{reason_text}}\n\nIf you paid online, a full refund will be processed to your original payment method within 5–7 business days.\n\nWe're sorry for the inconvenience. If you have any questions or wish to reorder, please reply to this message or visit illoo.store.\n\nThank you for your understanding. 🙏`,
  },

  payment_reminder: {
    name: 'COD Payment Reminder',
    template: (vars) =>
      `💰 *Payment Reminder — COD Order*\n\nHi {{parent_name}}! This is a friendly reminder that your illoo order *#{{order_id}}* is out for delivery today.\n\n💵 *Amount to Pay:* ₹{{amount}} (Cash on Delivery)\n\nPlease keep the exact amount of ₹{{amount}} ready for the delivery agent. \n\nFor any issues, reply to this message immediately. Thank you! 😊`,
  },
};

/**
 * Replace all {{variable}} placeholders in a template string.
 * @param {string} text - Template text with {{var}} placeholders
 * @param {Object} vars - Key-value pairs to substitute
 * @returns {string} - Fully substituted message
 */
function replacePlaceholders(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key] !== null && vars[key] !== undefined ? String(vars[key]) : '';
    }
    return match; // Leave unreplaced if var not provided
  });
}

/**
 * Build a final WhatsApp message from a template ID and variables.
 * @param {string} templateId - Key of TEMPLATES object
 * @param {Object} vars - Substitution variables
 * @returns {string} - Final message string
 * @throws {Error} - If templateId not found
 */
function buildMessage(templateId, vars = {}) {
  const template = TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Template not found: "${templateId}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  }

  // Generate the raw template text using the template function
  const rawText = template.template(vars);

  // Handle special computed fields
  const enrichedVars = { ...vars };

  // order_cancelled: build reason_text
  if (templateId === 'order_cancelled') {
    enrichedVars.reason_text = vars.reason
      ? `\n\n📝 *Reason:* ${vars.reason}`
      : '';
  }

  // Replace all {{placeholders}}
  return replacePlaceholders(rawText, enrichedVars);
}

module.exports = { TEMPLATES, buildMessage };
