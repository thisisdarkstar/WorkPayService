

// Create office (only if it does not exist)
export const createOffice = async (req, res) => {
  try {
    const {name, latitude, longitude, checkin, checkout, breakTime, range, autoFinalizeTime} = req.body;

    // Validate required fields
    if (!latitude || !longitude || !checkin || !checkout) {
      return res.status(400).json({ 
        error: "Missing required fields: latitude, longitude, checkin, checkout" 
      });
    }

    console.log('Creating office with data from body:');
    console.log('Latitude:', latitude);
    console.log('Longitude:', longitude);
    console.log('Checkin UTC:', checkin);
    console.log('Checkout UTC:', checkout);
    console.log('Break Time:', breakTime);
    console.log('Auto Finalize Time:', autoFinalizeTime);

    const office = await req.db.office.create({
      data: {
        name,
        latitude,
        longitude,
        checkin, // Already a valid date string from frontend
        checkout, // Already a valid date string from frontend
        breakTime: breakTime || 60 , // Default 1 hour break if not provided
        range:Number(range) || 1000,
        autoFinalizeTime: autoFinalizeTime ? new Date(autoFinalizeTime) : null,
      },
    });

    console.log('Office created successfully with ID:', office.id);

    res.status(201).json({ 
      message: "Office created successfully", 
      office
    });
  } catch (error) {
    console.error("Error creating office:", error);
    res.status(500).json({ error: "Failed to create office" });
  }
};


// ✅ Get Office Settings 
export const getOffices = async (req, res) => {
  try {
    const offices = await req.db.office.findMany({
      orderBy: { id: "asc" }
    });
    res.json({ message: "Office settings fetched successfully", offices: offices || [] });
  } catch (error) {
    console.error("Error fetching office:", error);
    res.status(500).json({ error: "Failed to fetch office" });
  }
};



// ✅ Update Office Settings
export const updateOffice = async (req, res) => {
  try {
    const { id } = req.params;
    const {name, latitude, longitude, checkin, checkout, breakTime, range, autoFinalizeTime} = req.body;

    const office = await req.db.office.findFirst(
      {
        where: { id: Number(id) }
      }
    );
    if (!office) {
      return res.status(404).json({ error: "Office settings not found. Please create first." });
    }

    const updateData = {
      name,
      latitude,
      longitude,
      checkin,
      checkout,
      breakTime,
      range: Number(range),
    };

    if (autoFinalizeTime !== undefined) {
      updateData.autoFinalizeTime = autoFinalizeTime ? new Date(autoFinalizeTime) : null;
    }

    const updatedOffice = await req.db.office.update({
      where: { id: office.id },
      data: updateData,
    });

    res.json({ message: `Office ${updatedOffice.name} settings updated successfully`, office: updatedOffice });
  } catch (error) {
    console.error("Error updating office:", error);
    res.status(500).json({ error: "Failed to update office" });
  }
};

// ✅ Delete Office Settings
export const deleteOffice = async (req, res) => {
  try {
    const { id } = req.params;
    const office = await req.db.office.findFirst(
      {
        where: { id: Number(id) }
      }
    );
    if (!office) {
      return res.status(404).json({ error: "Office settings not found" });
    }

    const associatedEmployees = await req.db.employee.findMany({
      where: { officeId: office.id },
      select: { id: true, name: true }
    });

    if (associatedEmployees.length > 0) {
      return res.status(400).json({ 
        error: "Cannot delete office with associated employees. Please reassign  employees first.",
      });
    }

    await req.db.office.delete({
      where: { id: office.id }
    });

    res.json({ message: `Office ${office.name} deleted successfully` });
  } catch (error) {
    console.error("Error deleting office:", error);
    res.status(500).json({ error: "Failed to delete office" });
  }
};
