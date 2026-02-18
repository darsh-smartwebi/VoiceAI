const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const grade1Routes = require("./grades/grade1Routes");
const gradekRoutes = require("./grades/gradekRoutes");
const grade2Routes = require("./grades/grade2Routes");
const grade3Routes = require("./grades/grade3Routes");
const grade4Routes = require("./grades/grade4Routes");
const grade5Routes = require("./grades/grade5Routes");
const grade6Routes = require("./grades/grade6Routes");
const grade7Routes = require("./grades/grade7Routes");
const grade8Routes = require("./grades/grade8Routes");

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
app.use("/gradek", gradekRoutes);
app.use("/grade2", grade2Routes);
app.use("/grade3", grade3Routes);
app.use("/grade4", grade4Routes);
app.use("/grade5", grade5Routes);
app.use("/grade6", grade6Routes);
app.use("/grade7", grade7Routes);
app.use("/grade8", grade8Routes);

app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 MCP server running on port ${process.env.PORT || 5050}`);
});
