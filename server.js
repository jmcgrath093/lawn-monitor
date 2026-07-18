const path = require('path');
const express = require('express');
const api = require('./src/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public')));

// Basic error handler so a thrown DB error returns JSON instead of an HTML stack trace
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Lawn Monitor listening on port ${PORT}`);
});
