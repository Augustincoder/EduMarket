// const { z } = require('zod');

/**
 * Validates request body, query, or params against a Zod schema.
 * 
 * @param {z.ZodSchema} schema - The Zod schema to validate against
 * @param {string} source - Where to look for data ('body', 'query', 'params')
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      // safeParse doesn't throw, but parse does.
      // We use parse so the global error handler can catch ZodError.
      const validData = schema.parse(req[source]);
      
      // Replace request data with parsed data (strips unknown fields)
      req[source] = validData;
      
      next();
    } catch (err) {
      // Forward ZodError to the global error handler
      next(err);
    }
  };
}

module.exports = { validate };
