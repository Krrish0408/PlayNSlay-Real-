
import { storage } from "./server/storage";

async function checkUsers() {
    const users = await storage.getAllUsers();
    console.log("Current Users in DB:");
    users.forEach(u => {
        console.log(`- Username: ${u.username}, Role: ${u.role}`);
    });
    process.exit(0);
}

checkUsers().catch(err => {
    console.error(err);
    process.exit(1);
});
