const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const grade1Routes = require("./grades/grade1Routes");

dotenv.config();

const app = express();

app.use(cors());
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "*/json", "*/*"],
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/grade1", grade1Routes);

app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 MCP server running on port ${process.env.PORT || 5050}`);
});
