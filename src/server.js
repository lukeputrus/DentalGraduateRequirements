require('dotenv').config();

// Ensure schema + seed data (schools, temp admin) exist before serving.
require('./db/seed');

const app = require('./app');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Dental Graduate Requirements app listening on port ${port}`);
});
