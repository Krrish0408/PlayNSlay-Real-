import { storage } from "./server/storage";

async function fixEmployeeRole() {
    console.log("Fixing employee role...");

    const employeeUser = await storage.getUserByUsername("Krrishjain6267@gmail.com");

    if (employeeUser) {
        console.log(`Current user state:`, {
            username: employeeUser.username,
            role: employeeUser.role,
        });

        await storage.updateUser(employeeUser.id, {
            role: 'employee',
        });

        const updated = await storage.getUserByUsername("Krrishjain6267@gmail.com");
        console.log(`Updated user state:`, {
            username: updated?.username,
            role: updated?.role,
        });

        console.log("✅ Employee role fixed!");
    } else {
        console.log("❌ Employee user not found");
    }

    process.exit(0);
}

fixEmployeeRole().catch(err => {
    console.error(err);
    process.exit(1);
});
